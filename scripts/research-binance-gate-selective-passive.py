import bisect, csv, gzip, hashlib, io, json, os, statistics, time, urllib.request, zipfile

OUTPUT = os.environ.get('RESEARCH_OUTPUT', '/tmp/binance-gate-selective-passive.json')
GATE_ARCHIVE = 'https://download.gatedata.org/futures_usdt/orderbooks'
BINANCE_ARCHIVE = 'https://data.binance.vision/data/futures/um/daily/aggTrades'
SYMBOLS = [('BTC_USDT','BTCUSDT'),('SOL_USDT','SOLUSDT'),('SUI_USDT','SUIUSDT')]
PRE_ERAS = [
    {'label':'era1','ymdh':'2023101512'},
    {'label':'era2','ymdh':'2024101512'},
    {'label':'era3','ymdh':'2025101512'},
]
EVAL_ERA = {'label':'evaluation','ymdh':'2026071512'}
OFFSETS_BPS = [2,4]
LOOKBACK_MS = [500,1000,2000]
THRESHOLDS_BPS = [1,2,4]
DECISION_MS = 2000
QUOTE_LIFETIME_MS = 6000
MARKOUT_MS = [5000,15000,30000]
MAKER_ONE_WAY = 0.0002
MAX_EXTERNAL_AGE_MS = 1500
MIN_PRE_FILLS = 20
MIN_VALID_BOOK_SECONDS = 3000
MAX_CROSSED_RATIO = 0.005
QUARANTINED = {('evaluation','SOL_USDT')}


def fetch_bytes(url, attempts=3, timeout=90):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'market-sentinel-research'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(0.5*(i+1))
    raise last


def mean(xs):
    return sum(xs)/len(xs) if xs else None


def pct(xs, q):
    if not xs: return None
    a = sorted(xs)
    return a[min(len(a)-1, max(0, int((len(a)-1)*q)))]


def infer_bid_sign(rows):
    pos = [r['price'] for r in rows if r['action']=='set' and r['size']>0]
    neg = [r['price'] for r in rows if r['action']=='set' and r['size']<0]
    if not pos or not neg: return None
    pm, nm = statistics.median(pos), statistics.median(neg)
    if pm == nm: return None
    return 1 if pm < nm else -1


def recompute_best(book, bid):
    if not book: return None
    return max(book) if bid else min(book)


def nearest_level(book, target, bid):
    chosen = None
    for p in book:
        if bid:
            if p <= target and (chosen is None or p > chosen): chosen = p
        else:
            if p >= target and (chosen is None or p < chosen): chosen = p
    return chosen


def new_stats():
    return {'placements':0,'fills':0,'expired':0,'bidFills':0,'askFills':0,
            'timeToFill':[], 'markout':{h:[] for h in MARKOUT_MS}}


def summarize_stats(s):
    out = {'placements':s['placements'],'fills':s['fills'],
           'fillRate':s['fills']/s['placements'] if s['placements'] else 0,
           'bidFills':s['bidFills'],'askFills':s['askFills'],'expired':s['expired'],
           'timeToFillMsP50':pct(s['timeToFill'],0.5),'timeToFillMsP90':pct(s['timeToFill'],0.9),
           'markout':{}}
    for h in MARKOUT_MS:
        arr=s['markout'][h]
        g=mean(arr)
        out['markout'][str(h)]={'n':len(arr),'grossMean':g,'makerNetMean':None if g is None else g-MAKER_ONE_WAY}
    return out


def config_key(offset, lookback, threshold):
    return f'{offset}|{lookback}|{threshold}'


def parse_config(key):
    o,l,t = key.split('|')
    return {'offsetBps':int(o),'lookbackMs':int(l),'thresholdBps':int(t)}


def load_binance(symbol, ymdh):
    ymd = f'{ymdh[:4]}-{ymdh[4:6]}-{ymdh[6:8]}'
    hour = int(ymdh[8:10])
    day_start = int(__import__('datetime').datetime(int(ymdh[:4]),int(ymdh[4:6]),int(ymdh[6:8]),tzinfo=__import__('datetime').timezone.utc).timestamp()*1000)
    start = day_start + hour*3600_000 - 5000
    end = day_start + (hour+1)*3600_000 + 5000
    url=f'{BINANCE_ARCHIVE}/{symbol}/{symbol}-aggTrades-{ymd}.zip'
    raw=fetch_bytes(url, timeout=120)
    times=[]; prices=[]; total=0
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names=[n for n in z.namelist() if n.endswith('.csv')]
        if not names: raise RuntimeError(f'no csv in {url}')
        with z.open(names[0]) as f:
            text=io.TextIOWrapper(f, encoding='utf-8', newline='')
            for row in csv.reader(text):
                if len(row)<6: continue
                try:
                    ts=int(float(row[5])); price=float(row[1])
                except: continue
                total += 1
                if start <= ts <= end and price>0:
                    times.append(ts); prices.append(price)
    if len(times)<100: raise RuntimeError(f'{symbol} {ymdh}: too few Binance events {len(times)}')
    return {'times':times,'prices':prices,'url':url,'dailyRows':total,'windowEvents':len(times)}


def external_return(ext, ts, lookback):
    times, prices = ext['times'], ext['prices']
    i=bisect.bisect_right(times, ts)-1
    target=ts-lookback
    j=bisect.bisect_right(times, target)-1
    if i<0 or j<0: return None
    if ts-times[i] > MAX_EXTERNAL_AGE_MS or target-times[j] > MAX_EXTERNAL_AGE_MS: return None
    if prices[j] <= 0: return None
    return prices[i]/prices[j]-1


def past_mid(mid_times, mid_prices, target):
    j=bisect.bisect_right(mid_times, target)-1
    if j<0: return None
    return mid_prices[j]


def analyze_hour(gate_symbol, bin_symbol, era):
    ext=load_binance(bin_symbol, era['ymdh'])
    ym=era['ymdh'][:6]
    gate_url=f'{GATE_ARCHIVE}/{ym}/{gate_symbol}-{era["ymdh"]}.csv.gz'
    raw=fetch_bytes(gate_url, timeout=120)
    stream=io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(raw)), encoding='utf-8', newline='')
    reader=csv.reader(stream)

    bids={}; asks={}; best_bid=None; best_ask=None; bid_sign=None
    current_ts=None; group=[]; prev_ts=None; last_ts=None
    groups=0; crossed=0; valid_book_ms=0; out_of_order=0
    mid_times=[]; mid_prices=[]

    baseline={}
    for o in OFFSETS_BPS:
        for side in ('bid','ask'):
            baseline[(o,side)]={'side':side,'offset':o,'nextDecision':None,'quote':None,'pending':[],'stats':new_stats()}
    filtered={}
    for o in OFFSETS_BPS:
        for lb in LOOKBACK_MS:
            for th in THRESHOLDS_BPS:
                k=config_key(o,lb,th)
                filtered[k]={'offset':o,'lookback':lb,'threshold':th,'nextDecision':None,'quote':None,'pending':[],'stats':new_stats(),'signalPlacements':0,'signalChecks':0}

    def side_for_size(size):
        if bid_sign is None or size==0: return None
        return 'bid' if (1 if size>0 else -1)==bid_sign else 'ask'

    def update_best(side, price, exists):
        nonlocal best_bid,best_ask
        if side=='bid':
            if exists and (best_bid is None or price>best_bid): best_bid=price
            elif not exists and best_bid==price: best_bid=recompute_best(bids,True)
        else:
            if exists and (best_ask is None or price<best_ask): best_ask=price
            elif not exists and best_ask==price: best_ask=recompute_best(asks,False)

    def all_states():
        return list(baseline.values()) + list(filtered.values())

    def apply_queue(row):
        if row['action']!='take' or bid_sign is None: return
        side=side_for_size(row['size']); amount=abs(row['size'])
        for st in all_states():
            q=st['quote']
            if q and q['side']==side and q['price']==row['price'] and not q['filled']:
                q['queue'] -= amount
                if q['queue'] <= 0: q['queueCleared']=True

    def apply_book(row):
        side=side_for_size(row['size'])
        if side is None: return
        book=bids if side=='bid' else asks
        amount=abs(row['size']); p=row['price']; a=row['action']
        if a=='set':
            if amount>0: book[p]=amount
            else: book.pop(p,None)
        elif a=='make':
            book[p]=book.get(p,0)+amount
        elif a=='take':
            nxt=book.get(p,0)-amount
            if nxt>1e-12: book[p]=nxt
            else: book.pop(p,None)
        update_best(side,p,p in book)

    def fill_quote(st, ts):
        q=st['quote']; side=q['side']; price=q['price']
        q['filled']=True; s=st['stats']; s['fills']+=1
        s['bidFills' if side=='bid' else 'askFills']+=1
        s['timeToFill'].append(ts-q['placedTs'])
        st['pending'].append({'fillTs':ts,'side':side,'price':price,'done':set()})
        st['quote']=None

    def evaluate_quotes(ts):
        if not (best_bid and best_ask and best_ask>best_bid): return
        for st in all_states():
            q=st['quote']
            if not q: continue
            if ts>q['expiryTs']:
                st['stats']['expired']+=1; st['quote']=None; continue
            if q['queueCleared']:
                if q['side']=='bid' and best_bid < q['price']: fill_quote(st,ts)
                elif q['side']=='ask' and best_ask > q['price']: fill_quote(st,ts)

    def update_markouts(ts):
        if not (best_bid and best_ask and best_ask>best_bid): return
        mid=(best_bid+best_ask)/2
        for st in all_states():
            for ev in st['pending']:
                for h in MARKOUT_MS:
                    if h in ev['done'] or ts < ev['fillTs']+h: continue
                    direction=1 if ev['side']=='bid' else -1
                    gross=direction*(mid/ev['price']-1)
                    st['stats']['markout'][h].append(gross); ev['done'].add(h)
            st['pending']=[e for e in st['pending'] if len(e['done'])<len(MARKOUT_MS)]

    def place(st, side, ts, mid):
        off=st['offset']; target=mid*(1-off/10000) if side=='bid' else mid*(1+off/10000)
        book=bids if side=='bid' else asks
        price=nearest_level(book,target,side=='bid')
        if price is None: return False
        queue=book.get(price,0)
        if queue<=0: return False
        st['quote']={'side':side,'price':price,'queue':queue,'queueCleared':False,'filled':False,
                     'placedTs':ts,'expiryTs':ts+QUOTE_LIFETIME_MS}
        st['stats']['placements']+=1
        return True

    def maybe_place(ts):
        if not (best_bid and best_ask and best_ask>best_bid): return
        mid=(best_bid+best_ask)/2
        # static baseline: independent bid and ask streams with the identical queue model
        for st in baseline.values():
            if st['nextDecision'] is None: st['nextDecision']=ts
            if ts < st['nextDecision']: continue
            while st['nextDecision']<=ts: st['nextDecision']+=DECISION_MS
            if st['quote'] is None: place(st,st['side'],ts,mid)
        # external filter: one side only when Binance has already moved more than Gate
        cache={}
        for lb in LOOKBACK_MS:
            br=external_return(ext,ts,lb)
            gm=past_mid(mid_times,mid_prices,ts-lb)
            gr=None if gm is None or gm<=0 else mid/gm-1
            cache[lb]=None if br is None or gr is None else (br-gr)*10000
        for st in filtered.values():
            if st['nextDecision'] is None: st['nextDecision']=ts
            if ts < st['nextDecision']: continue
            while st['nextDecision']<=ts: st['nextDecision']+=DECISION_MS
            if st['quote'] is not None: continue
            st['signalChecks']+=1
            residual=cache[st['lookback']]
            if residual is None: continue
            side='bid' if residual>=st['threshold'] else ('ask' if residual<=-st['threshold'] else None)
            if side and place(st,side,ts,mid): st['signalPlacements']+=1

    def flush_group():
        nonlocal group,current_ts,bid_sign,groups,crossed,valid_book_ms,prev_ts
        if current_ts is None or not group: return
        if bid_sign is None:
            bid_sign=infer_bid_sign(group)
            if bid_sign is None: raise RuntimeError(f'{gate_symbol} {era["ymdh"]}: cannot infer sides')
        for row in group:
            apply_queue(row); apply_book(row)
        groups+=1
        valid=best_bid is not None and best_ask is not None and best_ask>best_bid
        if best_bid is not None and best_ask is not None and best_bid>=best_ask: crossed+=1
        if prev_ts is not None and valid: valid_book_ms += max(0,current_ts-prev_ts)
        if valid:
            mid=(best_bid+best_ask)/2
            mid_times.append(current_ts); mid_prices.append(mid)
            evaluate_quotes(current_ts); update_markouts(current_ts); maybe_place(current_ts)
        prev_ts=current_ts; group=[]

    for row in reader:
        if len(row)<4: continue
        try:
            ts=int(float(row[0])*1000); action=row[1]; price=float(row[2]); size=float(row[3])
        except: continue
        if action not in ('set','make','take') or price<=0: continue
        if last_ts is not None and ts<last_ts: out_of_order+=1
        last_ts=ts
        if current_ts is None: current_ts=ts
        if ts!=current_ts:
            flush_group(); current_ts=ts
        group.append({'action':action,'price':price,'size':size})
    flush_group()

    crossed_ratio=crossed/groups if groups else 1
    quality=(era['label'],gate_symbol) not in QUARANTINED and valid_book_ms/1000>=MIN_VALID_BOOK_SECONDS and crossed_ratio<=MAX_CROSSED_RATIO and out_of_order==0
    base_summary={}
    for o in OFFSETS_BPS:
        # combine bid/ask by counts and weighted markout means
        a=summarize_stats(baseline[(o,'bid')]['stats']); b=summarize_stats(baseline[(o,'ask')]['stats'])
        comb={'placements':a['placements']+b['placements'],'fills':a['fills']+b['fills'],'markout':{}}
        comb['fillRate']=comb['fills']/comb['placements'] if comb['placements'] else 0
        for h in MARKOUT_MS:
            aa=a['markout'][str(h)]; bb=b['markout'][str(h)]; n=aa['n']+bb['n']
            g=((aa['grossMean'] or 0)*aa['n']+(bb['grossMean'] or 0)*bb['n'])/n if n else None
            comb['markout'][str(h)]={'n':n,'grossMean':g,'makerNetMean':None if g is None else g-MAKER_ONE_WAY}
        base_summary[str(o)]=comb
    filt_summary={k:{**summarize_stats(st['stats']),'signalChecks':st['signalChecks'],'signalPlacements':st['signalPlacements']} for k,st in filtered.items()}
    return {'era':era['label'],'symbol':gate_symbol,'binanceSymbol':bin_symbol,'ymdh':era['ymdh'],'qualityPass':quality,
            'groups':groups,'crossedRatio':crossed_ratio,'validBookSeconds':valid_book_ms/1000,'outOfOrder':out_of_order,
            'binanceWindowEvents':ext['windowEvents'],'baseline':base_summary,'filtered':filt_summary}


def weighted(rows, path):
    n=0; s=0.0
    for r in rows:
        obj=r
        for k in path: obj=obj[k]
        if obj['n'] and obj['grossMean'] is not None:
            n+=obj['n']; s+=obj['grossMean']*obj['n']
    g=s/n if n else None
    return {'n':n,'grossMean':g,'makerNetMean':None if g is None else g-MAKER_ONE_WAY}


def aggregate(records, era_label):
    rows=[r for r in records if r['era']==era_label and r['qualityPass']]
    base={}; filt={}
    for o in OFFSETS_BPS:
        placements=sum(r['baseline'][str(o)]['placements'] for r in rows); fills=sum(r['baseline'][str(o)]['fills'] for r in rows)
        base[str(o)]={'validHours':len(rows),'placements':placements,'fills':fills,'fillsPerSampleHour':fills/len(rows) if rows else 0,
                      'markout15':weighted(rows,['baseline',str(o),'markout','15000'])}
    for o in OFFSETS_BPS:
        for lb in LOOKBACK_MS:
            for th in THRESHOLDS_BPS:
                k=config_key(o,lb,th); placements=sum(r['filtered'][k]['placements'] for r in rows); fills=sum(r['filtered'][k]['fills'] for r in rows)
                m=weighted(rows,['filtered',k,'markout','15000']); bm=base[str(o)]['markout15']['makerNetMean']
                improv=None if m['makerNetMean'] is None or bm is None else (m['makerNetMean']-bm)*10000
                filt[k]={'validHours':len(rows),'placements':placements,'fills':fills,'fillsPerSampleHour':fills/len(rows) if rows else 0,
                         'markout15':m,'improvementVsBaselineBps':improv}
    return {'baseline':base,'filtered':filt}


def run_eras(eras):
    rec=[]
    for era in eras:
        for gs,bs in SYMBOLS:
            row=analyze_hour(gs,bs,era); rec.append(row)
            print('cross-venue',era['label'],gs,'quality',row['qualityPass'],'binEvents',row['binanceWindowEvents'])
    return rec

pre_records=run_eras(PRE_ERAS)
pre_aggs={e['label']:aggregate(pre_records,e['label']) for e in PRE_ERAS}
keys=[config_key(o,lb,th) for o in OFFSETS_BPS for lb in LOOKBACK_MS for th in THRESHOLDS_BPS]
qualified=[]; diagnostics=[]
for k in keys:
    vals=[pre_aggs[e['label']]['filtered'][k] for e in PRE_ERAS]
    pass_count=sum(1 for v in vals if v['fills']>=MIN_PRE_FILLS and v['markout15']['makerNetMean'] is not None and v['markout15']['makerNetMean']>=0 and (v['improvementVsBaselineBps'] or -999)>0)
    worst_net=min([(v['markout15']['makerNetMean'] if v['markout15']['makerNetMean'] is not None else -999)*10000 for v in vals])
    worst_imp=min([v['improvementVsBaselineBps'] if v['improvementVsBaselineBps'] is not None else -999 for v in vals])
    min_fills=min(v['fills'] for v in vals)
    d={**parse_config(k),'key':k,'preEraPassCount':pass_count,'worstPreMakerNetBps':worst_net,'worstPreImprovementBps':worst_imp,'minPreFills':min_fills,
       'eras':{e['label']:pre_aggs[e['label']]['filtered'][k] for e in PRE_ERAS}}
    diagnostics.append(d)
    if pass_count==len(PRE_ERAS): qualified.append(k)
diagnostics.sort(key=lambda x:(x['preEraPassCount'],x['worstPreMakerNetBps'],x['minPreFills']),reverse=True)

evaluation_opened=bool(qualified); eval_records=[]; eval_agg=None; eval_survivors=[]
if evaluation_opened:
    eval_records=run_eras([EVAL_ERA]); eval_agg=aggregate(eval_records,'evaluation')
    for k in qualified:
        v=eval_agg['filtered'][k]
        if v['fills']>=MIN_PRE_FILLS and v['markout15']['makerNetMean'] is not None and v['markout15']['makerNetMean']>=0 and (v['improvementVsBaselineBps'] or -999)>0:
            eval_survivors.append(k)

decision='CROSS_VENUE_SELECTIVE_PASSIVE_SURVIVES_SCREEN' if eval_survivors else ('CROSS_VENUE_PRE_EDGE_FAILS_EVALUATION' if evaluation_opened else 'CROSS_VENUE_FILTER_REJECTED_PRE_ERAS')
output_core={
 'research':'binance-gate-selective-passive-v1',
 'objective':'test whether already-observed Binance same-asset price changes can filter toxic Gate passive fills under the existing 2s control cadence',
 'protocol':{'symbols':SYMBOLS,'preEras':PRE_ERAS,'evaluationEra':EVAL_ERA,'gateDecisionMs':DECISION_MS,'quoteLifetimeMs':QUOTE_LIFETIME_MS,
             'offsetsBps':OFFSETS_BPS,'externalLookbacksMs':LOOKBACK_MS,'residualThresholdsBps':THRESHOLDS_BPS,'maxExternalAgeMs':MAX_EXTERNAL_AGE_MS,
             'makerOneWayBps':MAKER_ONE_WAY*10000,'fillModel':'existing Gate level at-or-farther than offset; behind all displayed queue; fill only after queue depletion and best moves through; one-sided filtered quote',
             'signal':'causal Binance return minus causal Gate midpoint return over same lookback; positive residual permits bid only, negative permits ask only',
             'baseline':'same Gate offset and queue model with independent always-on bid/ask streams',
             'preAcceptance':f'exact config must have >={MIN_PRE_FILLS} fills, nonnegative 15s maker-net markout, and positive improvement versus same-offset baseline in every 2023/2024/2025 era'},
 'decision':decision,'preQualifiedConfigs':qualified,'evaluationOpened':evaluation_opened,'evaluationSurvivors':eval_survivors,
 'preEraAggregates':pre_aggs,'evaluation':eval_agg if evaluation_opened else None,'topDiagnostics':diagnostics[:10],
 'validPreHours':sum(1 for r in pre_records if r['qualityPass']),'invalidPreHours':[{'era':r['era'],'symbol':r['symbol'],'crossedRatio':r['crossedRatio'],'validBookSeconds':r['validBookSeconds']} for r in pre_records if not r['qualityPass']],
 'records':pre_records + (eval_records if evaluation_opened else []),
 'interpretation':'This is a causal cross-venue toxicity-filter screen, not a production backtest. Failure rejects this external-return filter formulation; success would only justify broader multi-hour capacity/inventory validation.'}
sha=hashlib.sha256(json.dumps(output_core,sort_keys=True,separators=(',',':')).encode()).hexdigest()
out={**output_core,'sha256':sha,'generatedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
with open(OUTPUT,'w') as f: json.dump(out,f,indent=2)
print('BINANCE_GATE_SELECTIVE_PASSIVE='+json.dumps({'decision':decision,'preQualifiedConfigs':qualified,'evaluationOpened':evaluation_opened,'evaluationSurvivors':eval_survivors,'validPreHours':output_core['validPreHours'],'topDiagnostics':diagnostics[:5],'sha256':sha}))
