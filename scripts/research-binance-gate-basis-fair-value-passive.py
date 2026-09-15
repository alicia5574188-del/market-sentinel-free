import bisect, csv, gzip, hashlib, io, json, math, os, statistics, time, urllib.request, zipfile

OUTPUT = os.environ.get('RESEARCH_OUTPUT', '/tmp/binance-gate-basis-fair-value-passive.json')
GATE_ARCHIVE = 'https://download.gatedata.org/futures_usdt/orderbooks'
BINANCE_ARCHIVE = 'https://data.binance.vision/data/futures/um/daily/aggTrades'
SYMBOLS = [('BTC_USDT','BTCUSDT'),('SOL_USDT','SOLUSDT'),('SUI_USDT','SUIUSDT')]
PRE_ERAS = [
    {'label':'era1','date':'2023-10-15'},
    {'label':'era2','date':'2024-10-15'},
    {'label':'era3','date':'2025-10-15'},
]
EVAL_ERA = {'label':'evaluation','date':'2026-07-15'}
TEST_HOUR = 12
WARMUP_HOUR = 11
OFFSETS_BPS = [2,4]
BASIS_WINDOWS_MS = [300_000, 900_000, 3_600_000]
CUSHION_BPS = [3,5,8,12]
BASIS_EXCLUDE_RECENT_MS = 10_000
DECISION_MS = 2_000
QUOTE_LIFETIME_MS = 6_000
MARKOUT_MS = [5_000,15_000,30_000]
MAKER_ONE_WAY = 0.0002
MAX_EXTERNAL_AGE_MS = 1_500
MIN_BASIS_SAMPLES = 30
MIN_BASIS_SPAN_FRAC = 0.80
MIN_PRE_FILLS = 20
MIN_VALID_BOOK_SECONDS = 3_000
MAX_CROSSED_RATIO = 0.005
QUARANTINED_TEST = {('evaluation','SOL_USDT')}


def fetch_bytes(url, attempts=3, timeout=120):
    last=None
    for i in range(attempts):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'market-sentinel-research'})
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last=e
            time.sleep(0.5*(i+1))
    raise last


def mean(xs): return sum(xs)/len(xs) if xs else None

def pct(xs,q):
    if not xs: return None
    a=sorted(xs)
    return a[min(len(a)-1,max(0,int((len(a)-1)*q)))]


def recompute_best(book,bid):
    if not book: return None
    return max(book) if bid else min(book)


def infer_bid_sign(rows):
    pos=[r['price'] for r in rows if r['action']=='set' and r['size']>0]
    neg=[r['price'] for r in rows if r['action']=='set' and r['size']<0]
    if not pos or not neg: return None
    pm,nm=statistics.median(pos),statistics.median(neg)
    if pm==nm: return None
    return 1 if pm<nm else -1


def nearest_level(book,target,bid):
    chosen=None
    for p in book:
        if bid:
            if p<=target and (chosen is None or p>chosen): chosen=p
        else:
            if p>=target and (chosen is None or p<chosen): chosen=p
    return chosen


def new_stats():
    return {'placements':0,'fills':0,'expired':0,'bidFills':0,'askFills':0,
            'timeToFill':[],'markout':{h:[] for h in MARKOUT_MS},
            'basisBpsAtPlacement':[],'cushionBpsAtPlacement':[]}


def summarize_stats(s):
    out={'placements':s['placements'],'fills':s['fills'],
         'fillRate':s['fills']/s['placements'] if s['placements'] else 0,
         'bidFills':s['bidFills'],'askFills':s['askFills'],'expired':s['expired'],
         'timeToFillMsP50':pct(s['timeToFill'],0.5),'timeToFillMsP90':pct(s['timeToFill'],0.9),
         'basisBpsAtPlacementP50':pct(s['basisBpsAtPlacement'],0.5),
         'cushionBpsAtPlacementP50':pct(s['cushionBpsAtPlacement'],0.5),
         'markout':{}}
    for h in MARKOUT_MS:
        arr=s['markout'][h]; g=mean(arr)
        out['markout'][str(h)]={'n':len(arr),'grossMean':g,'makerNetMean':None if g is None else g-MAKER_ONE_WAY}
    return out


def ymdh(date,hour): return date.replace('-','')+f'{hour:02d}'

def day_start_ms(date):
    import datetime
    y,m,d=map(int,date.split('-'))
    return int(datetime.datetime(y,m,d,tzinfo=datetime.timezone.utc).timestamp()*1000)


def load_binance(symbol,date):
    url=f'{BINANCE_ARCHIVE}/{symbol}/{symbol}-aggTrades-{date}.zip'
    raw=fetch_bytes(url,timeout=180)
    start=day_start_ms(date)+(WARMUP_HOUR*3600_000)-5_000
    end=day_start_ms(date)+((TEST_HOUR+1)*3600_000)+5_000
    times=[]; prices=[]; total=0
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names=[n for n in z.namelist() if n.endswith('.csv')]
        if not names: raise RuntimeError(f'no csv in {url}')
        with z.open(names[0]) as f:
            text=io.TextIOWrapper(f,encoding='utf-8',newline='')
            for row in csv.reader(text):
                if len(row)<6: continue
                try:
                    ts=int(float(row[5])); price=float(row[1])
                except Exception: continue
                total += 1
                if start<=ts<=end and price>0:
                    times.append(ts); prices.append(price)
    if len(times)<100: raise RuntimeError(f'{symbol} {date}: too few Binance events {len(times)}')
    return {'times':times,'prices':prices,'url':url,'dailyRows':total,'windowEvents':len(times)}


def ext_price(ext,ts):
    i=bisect.bisect_right(ext['times'],ts)-1
    if i<0 or ts-ext['times'][i]>MAX_EXTERNAL_AGE_MS: return None
    return ext['prices'][i]


def config_key(offset,window,cushion): return f'{offset}|{window}|{cushion}'

def parse_config(key):
    o,w,c=key.split('|')
    return {'offsetBps':int(o),'basisWindowMs':int(w),'cushionBps':int(c)}


def read_gate_hour(symbol,date,hour):
    key=ymdh(date,hour); ym=key[:6]
    url=f'{GATE_ARCHIVE}/{ym}/{symbol}-{key}.csv.gz'
    raw=fetch_bytes(url,timeout=180)
    stream=io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(raw)),encoding='utf-8',newline='')
    rows=[]; last_ts=None; out_of_order=0
    for row in csv.reader(stream):
        if len(row)<4: continue
        try:
            ts=int(float(row[0])*1000); action=row[1]; price=float(row[2]); size=float(row[3])
        except Exception: continue
        if action not in ('set','make','take') or price<=0: continue
        if last_ts is not None and ts<last_ts: out_of_order+=1
        last_ts=ts
        rows.append({'ts':ts,'action':action,'price':price,'size':size})
    if not rows: raise RuntimeError(f'empty Gate hour {symbol} {key}')
    return rows,url,out_of_order


def analyze_symbol_era(gate_symbol,bin_symbol,era):
    ext=load_binance(bin_symbol,era['date'])
    rows11,url11,ooo11=read_gate_hour(gate_symbol,era['date'],WARMUP_HOUR)
    rows12,url12,ooo12=read_gate_hour(gate_symbol,era['date'],TEST_HOUR)
    rows=rows11+rows12

    bids={}; asks={}; best_bid=None; best_ask=None; bid_sign=None
    current_ts=None; group=[]; prev_ts=None; next_decision_ts=None
    groups_by_hour={WARMUP_HOUR:0,TEST_HOUR:0}; crossed_by_hour={WARMUP_HOUR:0,TEST_HOUR:0}; valid_ms_by_hour={WARMUP_HOUR:0,TEST_HOUR:0}
    basis_samples=[]

    baseline={}
    for o in OFFSETS_BPS:
        for side in ('bid','ask'):
            baseline[(o,side)]={'offset':o,'side':side,'quote':None,'pending':[],'stats':new_stats()}
    filtered={}
    for o in OFFSETS_BPS:
        for w in BASIS_WINDOWS_MS:
            for c in CUSHION_BPS:
                k=config_key(o,w,c)
                for side in ('bid','ask'):
                    filtered[(k,side)]={'key':k,'offset':o,'window':w,'cushion':c,'side':side,'quote':None,'pending':[],'stats':new_stats(),'basisChecks':0,'basisReady':0}

    def side_for_size(size):
        if bid_sign is None or size==0: return None
        return 'bid' if (1 if size>0 else -1)==bid_sign else 'ask'

    def update_best(side,price,exists):
        nonlocal best_bid,best_ask
        if side=='bid':
            if exists and (best_bid is None or price>best_bid): best_bid=price
            elif not exists and best_bid==price: best_bid=recompute_best(bids,True)
        else:
            if exists and (best_ask is None or price<best_ask): best_ask=price
            elif not exists and best_ask==price: best_ask=recompute_best(asks,False)

    def all_states(): return list(baseline.values())+list(filtered.values())

    def apply_queue(row):
        if row['action']!='take' or bid_sign is None: return
        side=side_for_size(row['size']); amount=abs(row['size'])
        for st in all_states():
            q=st['quote']
            if q and q['side']==side and q['price']==row['price']:
                q['queue'] -= amount
                if q['queue']<=0: q['queueCleared']=True

    def apply_book(row):
        side=side_for_size(row['size'])
        if side is None: return
        book=bids if side=='bid' else asks
        amount=abs(row['size']); p=row['price']; a=row['action']
        if a=='set':
            if amount>0: book[p]=amount
            else: book.pop(p,None)
        elif a=='make': book[p]=book.get(p,0)+amount
        elif a=='take':
            nxt=book.get(p,0)-amount
            if nxt>1e-12: book[p]=nxt
            else: book.pop(p,None)
        update_best(side,p,p in book)

    def fill_quote(st,ts):
        q=st['quote']; side=q['side']; price=q['price']; s=st['stats']
        s['fills']+=1; s['bidFills' if side=='bid' else 'askFills']+=1; s['timeToFill'].append(ts-q['placedTs'])
        st['pending'].append({'fillTs':ts,'side':side,'price':price,'done':set()}); st['quote']=None

    def evaluate_quotes(ts):
        if not (best_bid and best_ask and best_ask>best_bid): return
        for st in all_states():
            q=st['quote']
            if not q: continue
            if ts>q['expiryTs']:
                st['stats']['expired']+=1; st['quote']=None; continue
            if q['queueCleared']:
                if q['side']=='bid' and best_bid<q['price']: fill_quote(st,ts)
                elif q['side']=='ask' and best_ask>q['price']: fill_quote(st,ts)

    def update_markouts(ts):
        if not (best_bid and best_ask and best_ask>best_bid): return
        mid=(best_bid+best_ask)/2
        for st in all_states():
            for ev in st['pending']:
                for h in MARKOUT_MS:
                    if h in ev['done'] or ts<ev['fillTs']+h: continue
                    direction=1 if ev['side']=='bid' else -1
                    st['stats']['markout'][h].append(direction*(mid/ev['price']-1)); ev['done'].add(h)
            st['pending']=[e for e in st['pending'] if len(e['done'])<len(MARKOUT_MS)]

    def place(st,ts,mid,fair=None,basis_bps=None):
        side=st['side']; off=st['offset']; target=mid*(1-off/10000) if side=='bid' else mid*(1+off/10000)
        book=bids if side=='bid' else asks; price=nearest_level(book,target,side=='bid')
        if price is None: return False
        queue=book.get(price,0)
        if queue<=0: return False
        if fair is not None:
            actual=(fair/price-1)*10000 if side=='bid' else (price/fair-1)*10000
            if actual+1e-12 < st['cushion']: return False
            st['stats']['basisBpsAtPlacement'].append(basis_bps); st['stats']['cushionBpsAtPlacement'].append(actual)
        st['quote']={'side':side,'price':price,'queue':queue,'queueCleared':False,'placedTs':ts,'expiryTs':ts+QUOTE_LIFETIME_MS}
        st['stats']['placements']+=1; return True

    def basis_estimate(ts,window):
        cutoff=ts-BASIS_EXCLUDE_RECENT_MS; start=cutoff-window
        vals=[]; first=None; last=None
        for t,b in basis_samples:
            if t<start: continue
            if t>cutoff: break
            vals.append(b); first=t if first is None else first; last=t
        if len(vals)<MIN_BASIS_SAMPLES or first is None or last is None: return None
        if last-first < window*MIN_BASIS_SPAN_FRAC: return None
        return statistics.median(vals)

    def decision(ts):
        nonlocal next_decision_ts
        if not (best_bid and best_ask and best_ask>best_bid): return
        if next_decision_ts is None: next_decision_ts=ts
        if ts<next_decision_ts: return
        while next_decision_ts<=ts: next_decision_ts+=DECISION_MS
        mid=(best_bid+best_ask)/2; ep=ext_price(ext,ts)
        if ep is None: return
        basis_samples.append((ts,math.log(mid/ep)))
        test_start=day_start_ms(era['date'])+TEST_HOUR*3600_000
        if ts<test_start or ts>=test_start+3600_000: return
        for st in baseline.values():
            if st['quote'] is None: place(st,ts,mid)
        cache={w:basis_estimate(ts,w) for w in BASIS_WINDOWS_MS}
        for st in filtered.values():
            if st['quote'] is not None: continue
            st['basisChecks']+=1; be=cache[st['window']]
            if be is None: continue
            st['basisReady']+=1; fair=ep*math.exp(be)
            place(st,ts,mid,fair,be*10000)

    def flush_group():
        nonlocal group,current_ts,bid_sign,prev_ts
        if current_ts is None or not group: return
        if bid_sign is None:
            bid_sign=infer_bid_sign(group)
            if bid_sign is None: raise RuntimeError(f'{gate_symbol} {era["date"]}: cannot infer sides')
        for row in group:
            apply_queue(row); apply_book(row)
        hour=int((current_ts-day_start_ms(era['date']))//3600_000)
        if hour in groups_by_hour:
            groups_by_hour[hour]+=1
            valid=best_bid is not None and best_ask is not None and best_ask>best_bid
            if best_bid is not None and best_ask is not None and best_bid>=best_ask: crossed_by_hour[hour]+=1
            if prev_ts is not None and valid:
                prev_hour=int((prev_ts-day_start_ms(era['date']))//3600_000)
                if prev_hour==hour: valid_ms_by_hour[hour]+=max(0,current_ts-prev_ts)
        if best_bid is not None and best_ask is not None and best_ask>best_bid:
            evaluate_quotes(current_ts); update_markouts(current_ts); decision(current_ts)
        prev_ts=current_ts; group=[]

    for row in rows:
        ts=row['ts']
        if current_ts is None: current_ts=ts
        if ts!=current_ts:
            flush_group(); current_ts=ts
        group.append(row)
    flush_group()

    q11=(valid_ms_by_hour[WARMUP_HOUR]/1000>=MIN_VALID_BOOK_SECONDS and (crossed_by_hour[WARMUP_HOUR]/groups_by_hour[WARMUP_HOUR] if groups_by_hour[WARMUP_HOUR] else 1)<=MAX_CROSSED_RATIO and ooo11==0)
    q12=(valid_ms_by_hour[TEST_HOUR]/1000>=MIN_VALID_BOOK_SECONDS and (crossed_by_hour[TEST_HOUR]/groups_by_hour[TEST_HOUR] if groups_by_hour[TEST_HOUR] else 1)<=MAX_CROSSED_RATIO and ooo12==0 and (era['label'],gate_symbol) not in QUARANTINED_TEST)
    quality=q11 and q12

    base_summary={}
    for o in OFFSETS_BPS:
        parts=[summarize_stats(baseline[(o,s)]['stats']) for s in ('bid','ask')]
        placements=sum(x['placements'] for x in parts); fills=sum(x['fills'] for x in parts); markout={}
        for h in MARKOUT_MS:
            vals=[x['markout'][str(h)] for x in parts]; n=sum(v['n'] for v in vals)
            gm=sum((v['grossMean'] or 0)*v['n'] for v in vals)/n if n else None
            markout[str(h)]={'n':n,'grossMean':gm,'makerNetMean':None if gm is None else gm-MAKER_ONE_WAY}
        base_summary[str(o)]={'placements':placements,'fills':fills,'markout':markout}

    filt_summary={}
    for o in OFFSETS_BPS:
        for w in BASIS_WINDOWS_MS:
            for c in CUSHION_BPS:
                k=config_key(o,w,c); parts=[summarize_stats(filtered[(k,s)]['stats']) for s in ('bid','ask')]
                placements=sum(x['placements'] for x in parts); fills=sum(x['fills'] for x in parts); markout={}
                for h in MARKOUT_MS:
                    vals=[x['markout'][str(h)] for x in parts]; n=sum(v['n'] for v in vals)
                    gm=sum((v['grossMean'] or 0)*v['n'] for v in vals)/n if n else None
                    markout[str(h)]={'n':n,'grossMean':gm,'makerNetMean':None if gm is None else gm-MAKER_ONE_WAY}
                filt_summary[k]={'placements':placements,'fills':fills,'markout':markout,'bidFills':parts[0]['bidFills'],'askFills':parts[1]['askFills'],'basisReady':sum(filtered[(k,s)]['basisReady'] for s in ('bid','ask'))}

    return {'era':era['label'],'date':era['date'],'gateSymbol':gate_symbol,'binanceSymbol':bin_symbol,'qualityPass':quality,'warmupQuality':q11,'testQuality':q12,'warmupValidSeconds':valid_ms_by_hour[WARMUP_HOUR]/1000,'testValidSeconds':valid_ms_by_hour[TEST_HOUR]/1000,'warmupCrossedRatio':crossed_by_hour[WARMUP_HOUR]/groups_by_hour[WARMUP_HOUR] if groups_by_hour[WARMUP_HOUR] else 1,'testCrossedRatio':crossed_by_hour[TEST_HOUR]/groups_by_hour[TEST_HOUR] if groups_by_hour[TEST_HOUR] else 1,'gateUrls':[url11,url12],'binanceUrl':ext['url'],'binanceWindowEvents':ext['windowEvents'],'basisSamples':len(basis_samples),'baseline':base_summary,'filtered':filt_summary}


def aggregate(records,era_label,key=None,offset=None):
    rows=[r for r in records if r['era']==era_label and r.get('qualityPass')]
    vals=[r['baseline'][str(offset)] if key is None else r['filtered'][key] for r in rows]
    placements=sum(v['placements'] for v in vals); fills=sum(v['fills'] for v in vals); pieces=[]
    for v in vals:
        m=v['markout']['15000']
        if m['n'] and m['makerNetMean'] is not None: pieces.append((m['n'],m['makerNetMean']))
    n=sum(a for a,_ in pieces); maker=sum(a*b for a,b in pieces)/n if n else None
    return {'validHours':len(rows),'placements':placements,'fills':fills,'fillsPerSampleHour':fills/len(rows) if rows else 0,'makerNet15Mean':maker,'makerNet15Bps':None if maker is None else maker*10000}

records=[]
for era in PRE_ERAS:
    for g,b in SYMBOLS:
        try:
            row=analyze_symbol_era(g,b,era); records.append(row)
            print('basis-fair',era['label'],g,'quality',row['qualityPass'],'basisSamples',row['basisSamples'])
        except Exception as e:
            records.append({'era':era['label'],'date':era['date'],'gateSymbol':g,'binanceSymbol':b,'qualityPass':False,'error':repr(e)})
            print('basis-fair failed',era['label'],g,repr(e))

configs=[]
for o in OFFSETS_BPS:
    for w in BASIS_WINDOWS_MS:
        for c in CUSHION_BPS:
            k=config_key(o,w,c); per={}; pass_count=0
            for era in PRE_ERAS:
                a=aggregate(records,era['label'],k); b=aggregate(records,era['label'],None,o)
                imp=None if a['makerNet15Bps'] is None or b['makerNet15Bps'] is None else a['makerNet15Bps']-b['makerNet15Bps']
                ok=(a['fills']>=MIN_PRE_FILLS and a['makerNet15Mean'] is not None and a['makerNet15Mean']>=0 and imp is not None and imp>0)
                pass_count += int(ok); per[era['label']]={**a,'baselineMakerNet15Bps':b['makerNet15Bps'],'improvementVsBaselineBps':imp,'pass':ok}
            configs.append({**parse_config(k),'key':k,'preEraPassCount':pass_count,'eras':per,'minPreFills':min(per[e['label']]['fills'] for e in PRE_ERAS),'worstPreMakerNetBps':min((per[e['label']]['makerNet15Bps'] if per[e['label']]['makerNet15Bps'] is not None else -999) for e in PRE_ERAS),'worstPreImprovementBps':min((per[e['label']]['improvementVsBaselineBps'] if per[e['label']]['improvementVsBaselineBps'] is not None else -999) for e in PRE_ERAS)})

qualified=[x for x in configs if x['preEraPassCount']==len(PRE_ERAS)]
evaluation_opened=bool(qualified); eval_records=[]; eval_survivors=[]
if evaluation_opened:
    for g,b in SYMBOLS:
        try: eval_records.append(analyze_symbol_era(g,b,EVAL_ERA))
        except Exception as e: eval_records.append({'era':'evaluation','date':EVAL_ERA['date'],'gateSymbol':g,'binanceSymbol':b,'qualityPass':False,'error':repr(e)})
    for q in qualified:
        a=aggregate(eval_records,'evaluation',q['key']); b=aggregate(eval_records,'evaluation',None,q['offsetBps'])
        imp=None if a['makerNet15Bps'] is None or b['makerNet15Bps'] is None else a['makerNet15Bps']-b['makerNet15Bps']
        if a['fills']>=MIN_PRE_FILLS and a['makerNet15Mean'] is not None and a['makerNet15Mean']>=0 and imp is not None and imp>0:
            eval_survivors.append({**q,'evaluation':{**a,'baselineMakerNet15Bps':b['makerNet15Bps'],'improvementVsBaselineBps':imp}})

decision=('BASIS_NORMALIZED_FAIR_VALUE_EDGE_SURVIVES_SCREEN' if eval_survivors else 'BASIS_NORMALIZED_FAIR_VALUE_PRE_EDGE_FAILS_EVALUATION' if qualified else 'BASIS_NORMALIZED_FAIR_VALUE_REJECTED_PRE_ERAS')
top=sorted(configs,key=lambda x:(x['preEraPassCount'],x['worstPreMakerNetBps'],x['worstPreImprovementBps'],x['minPreFills']),reverse=True)[:10]
output_core={'research':'binance-gate-basis-fair-value-passive-v1','objective':'test whether a persistent basis-normalized Binance fair value can identify Gate passive quote prices with a pre-existing economic cushion large enough to avoid the toxic fills seen in #253/#255','protocol':{'symbols':SYMBOLS,'preEras':PRE_ERAS,'evaluationEra':EVAL_ERA,'gateWarmupHourUtc':WARMUP_HOUR,'gateTestHourUtc':TEST_HOUR,'gateDecisionMs':DECISION_MS,'quoteLifetimeMs':QUOTE_LIFETIME_MS,'offsetsBps':OFFSETS_BPS,'basisWindowsMs':BASIS_WINDOWS_MS,'basisExcludeRecentMs':BASIS_EXCLUDE_RECENT_MS,'cushionThresholdsBps':CUSHION_BPS,'maxExternalAgeMs':MAX_EXTERNAL_AGE_MS,'makerOneWayBps':MAKER_ONE_WAY*10000,'basis':'rolling median of log(Gate midpoint / causal Binance last price), excluding the most recent 10s so the current dislocation cannot rewrite its own normal basis','fairValue':'latest causal Binance price multiplied by exp(trailing median venue basis)','selection':'bid only when adjusted fair value exceeds actual Gate quote price by threshold; ask only when actual Gate quote exceeds adjusted fair value by threshold','fillModel':'existing Gate level at-or-farther than 2/4bp offset; behind all displayed queue; fill only after queue depletion and same-side best moves through','baseline':'same Gate offset/queue model with independent always-on bid/ask streams','preAcceptance':f'exact config >={MIN_PRE_FILLS} fills, nonnegative 15s maker-net markout, and positive improvement versus same-offset baseline in every pre era'},'validPreHours':sum(1 for r in records if r.get('qualityPass')),'invalidPreHours':[{'era':r.get('era'),'symbol':r.get('gateSymbol'),'error':r.get('error'),'warmupQuality':r.get('warmupQuality'),'testQuality':r.get('testQuality')} for r in records if not r.get('qualityPass')],'preQualifiedConfigs':[q['key'] for q in qualified],'evaluationOpened':evaluation_opened,'evaluationSurvivors':[q['key'] for q in eval_survivors],'decision':decision,'topDiagnostics':top,'records':records if os.environ.get('RESEARCH_VERBOSE')=='1' else []}
sha256=hashlib.sha256(json.dumps(output_core,sort_keys=True,separators=(',',':')).encode()).hexdigest()
out={**output_core,'sha256':sha256,'generatedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
with open(OUTPUT,'w') as f: json.dump(out,f,indent=2)
print('BASIS_FAIR_VALUE_PASSIVE='+json.dumps({'decision':decision,'preQualifiedConfigs':[q['key'] for q in qualified],'evaluationOpened':evaluation_opened,'evaluationSurvivors':[q['key'] for q in eval_survivors],'validPreHours':output_core['validPreHours'],'topDiagnostics':top[:5],'sha256':sha256}))
