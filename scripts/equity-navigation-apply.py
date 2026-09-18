from pathlib import Path
import hashlib

def edit(path,before,after,edits):
    p=Path(path);raw=p.read_bytes();assert hashlib.sha256(raw).hexdigest()==before,'Base mismatch '+path
    lines=raw.decode().splitlines(keepends=True)
    for a,b,text in reversed(edits):lines[a:b]=[text]
    out=''.join(lines).encode();assert hashlib.sha256(out).hexdigest()==after,'Target mismatch '+path
    p.write_bytes(out);print('VERIFIED',path,after)

edit('app/equity-curve.tsx','622846aea3c37e95d5eb931dbd9ede4ef7144a345a4b00b1b7848237c0aca9d3','4e8da5fabc72510ce7427401e4860edb157beb75b5108bb4970b918c2a36b7b0',[
(17,18,'  const [clock,setClock]=useState(()=>Date.now()),[oldestRequest,setOldestRequest]=useState<number|null>(null);\n'),
(30,31,'    const target=range==="all"?account:Math.max(account,Math.min(Date.now()-7*DAY_MS,oldestRequest??Infinity));\n'),
(33,35,'      let r:Response|null=null;\n      for(let attempt=0;attempt<3;attempt++){\n        r=await fetch(`/api/forward/equity${cursor?`?cursor=${encodeURIComponent(cursor)}`:""}`,{\n          credentials:"same-origin",cache:"no-store",signal:controller.signal});\n        if(r.status!==429||attempt===2)break;await pause();\n      }\n      if(!r)throw new Error("净值记录读取失败。");\n'),
(68,69,'  },[account,range,loadBatch,fixture,oldestRequest]);\n'),
(85,85,'  useEffect(()=>{\n    if(fixture||loading||error||history.done||!history.loaded||history.coveredTo==null||atLatest.current\n      ||visibleStart>=history.coveredTo)return;\n    const timer=setTimeout(()=>setOldestRequest(old=>Math.min(old??Infinity,Math.max(account,visibleStart-DAY_MS))),300);\n    return()=>clearTimeout(timer);\n  },[fixture,loading,error,history.done,history.loaded,history.coveredTo,visibleStart,account]);\n'),
(90,91,'  const needsMore=!fixture&&!history.done&&(range==="all"||history.coveredTo==null||history.coveredTo>Math.max(account,Math.min(liveNow-7*DAY_MS,visibleStart)));\n'),
(117,118,'    <p className="eq-hint">左右滑动查看，轻触曲线读取原始记录。{range==="all"?"显示已加载全程。":end-account<span?"运行时间不足所选周期，显示已有记录。":canvasWidth>=20000?"长历史已压缩显示。":range==="7d"?"每屏7天。":"每屏24小时。"}空白处不补造；曲线仅作平滑连接，数字和建议均用原始值。</p>\n'),
(119,120,'    {(loading||error||needsMore)&&<div className="eq-load" role="status"><span>{error??(loading?"正在分批读取已保存的历史…":"当前窗口历史尚未读取完整")}</span>{!loading&&<button onClick={()=>{setOldestRequest(old=>Math.min(old??Infinity,Math.max(account,visibleStart-DAY_MS)));setLoadBatch(n=>n+1);}}>继续加载</button>}</div>}\n'),
])
edit('research/EQUITY_CURVE_REFERENCE.md','0dfcf9f5afe4b3e6fe5a7262b2c17f85de6fde3a2d375e0095ab6facc5a05df5','713c1c18a9711e10883f4ba49596bc25331bc50422a16af4c53961c6cad59146',[
(18,19,"The browser starts with recent observations, reads up to32pages per batch with700ms spacing, yields30seconds between unfinished batches and updates the latest page once/minute only while visible. Dragging or navigating beyond the loaded history requests older archive pages without changing the selected zoom; selecting all also loads earlier history. A temporary busy response receives at most3attempts, not an unlimited retry loop. Selecting24hours does not change the reference's7day lookback. Page cursors, including zero-observation pages, are tracked independently of point count. Requests are aborted on unmount. Owner and authorized members share only the existing PAPER equity source; guests remain401. No private member balance, Gate PnL, API key or execution state is exposed by the new route.\n"),
(32,33,'33new tests cover archive freshness/identity/split/dedup/gaps, exact origin, monotone interpolation, immutable pagination/cache/rate/single-flight, original source archive integration, causal reference signals, immature/losing outcomes, incomplete history, policy boundaries and actual owner/member Worker authentication with no Gate/writes/alarms. Existing frozen primary-method/source/storage/quantity/protection tests remain intact. Actual component offline checks at320/393/768/1440cover native scroll,7day default, start1,000, ranges, raw-point readout and overflow; mobile touch is browser emulation, not physical-iPhone certification. Fixtures are explicitly synthetic and not production performance. A separate real-component loader exercise uses synthetic4032marks and accelerated pause timers: initialweek33requests including1busy retry, then origin navigation loads through finalpage62 in66totalrequests while keeping7day zoom. Full local/remote tests and ordinary exact-head PRCI precede reviewed main; public production receipt must show exact build, preserved source/owner boundaries and another advancing saved cycle. Authenticated personal account data is not opened for verification.\n'),
])
