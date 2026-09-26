import json, math, os, time
import numpy as np
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, accuracy_score, mean_absolute_error

INPUT=os.environ.get("PREDICTIVE_TRAINING_SET","/tmp/predictive-training.jsonl")
META=os.environ.get("PREDICTIVE_TRAINING_META","/tmp/predictive-training-meta.json")
OUTPUT=os.environ.get("PREDICTIVE_ARTIFACT","lib/predictive-path-artifact-v1.json")
COST=0.0019
rows=[]
with open(INPUT,"r",encoding="utf-8") as f:
    for line in f:
        if line.strip(): rows.append(json.loads(line))
if len(rows)<20000: raise RuntimeError(f"insufficient rows {len(rows)}")
with open(META,"r",encoding="utf-8") as f: meta=json.load(f)
names=list(meta.get("featureNames") or [])
if not names: raise RuntimeError("missing predictive feature schema")
rows.sort(key=lambda r:r["at"])
for r in rows:
    if len(r["x"])!=len(names): raise RuntimeError("feature width drift")
n=len(rows); t1=rows[int(n*.70)]["at"]; t2=rows[int(n*.85)]["at"]; embargo=120*60*1000
train=[r for r in rows if r["at"]<t1-embargo]
valid=[r for r in rows if r["at"]>=t1 and r["at"]<t2-embargo]
test=[r for r in rows if r["at"]>=t2]
if min(len(train),len(valid),len(test))<1000: raise RuntimeError("chronological split too small")

Xtr=np.asarray([r["x"] for r in train],dtype=np.float32)
Xv=np.asarray([r["x"] for r in valid],dtype=np.float32)
Xt=np.asarray([r["x"] for r in test],dtype=np.float32)
feature_count=Xtr.shape[1]

COMMON=dict(n_estimators=140,learning_rate=.035,num_leaves=15,max_depth=5,min_child_samples=180,
            subsample=.85,colsample_bytree=.82,reg_lambda=1.2,reg_alpha=.05,random_state=5574,n_jobs=2,verbosity=-1)

def fit_classifier(target):
    ytr=np.asarray([target(r) for r in train],dtype=np.int8)
    yv=np.asarray([target(r) for r in valid],dtype=np.int8)
    model=lgb.LGBMClassifier(objective="binary",**COMMON)
    model.fit(Xtr,ytr,eval_set=[(Xv,yv)],callbacks=[lgb.early_stopping(18,verbose=False)])
    rawv=model.booster_.predict(Xv,raw_score=True)
    cal=LogisticRegression(C=1000.0,solver="lbfgs",max_iter=300).fit(rawv.reshape(-1,1),yv)
    return model,{"a":float(cal.coef_[0,0]),"b":float(cal.intercept_[0])}

def fit_touch(field):
    tr=[r for r in train if r[field] in (0,1)]; va=[r for r in valid if r[field] in (0,1)]
    if min(len(tr),len(va))<500: raise RuntimeError(f"touch sample shortage {field}")
    xtr=np.asarray([r["x"] for r in tr],dtype=np.float32); ytr=np.asarray([r[field] for r in tr],dtype=np.int8)
    xv=np.asarray([r["x"] for r in va],dtype=np.float32); yv=np.asarray([r[field] for r in va],dtype=np.int8)
    model=lgb.LGBMClassifier(objective="binary",**COMMON)
    model.fit(xtr,ytr,eval_set=[(xv,yv)],callbacks=[lgb.early_stopping(18,verbose=False)])
    rawv=model.booster_.predict(xv,raw_score=True)
    cal=LogisticRegression(C=1000.0,solver="lbfgs",max_iter=300).fit(rawv.reshape(-1,1),yv)
    return model,{"a":float(cal.coef_[0,0]),"b":float(cal.intercept_[0])}

def fit_regressor(target,objective="huber"):
    ytr=np.asarray([target(r) for r in train],dtype=np.float32)
    yv=np.asarray([target(r) for r in valid],dtype=np.float32)
    model=lgb.LGBMRegressor(objective=objective,**COMMON)
    model.fit(Xtr,ytr,eval_set=[(Xv,yv)],callbacks=[lgb.early_stopping(18,verbose=False)])
    return model

def compact(node):
    if "leaf_value" in node: return {"v":float(node["leaf_value"])}
    if node.get("decision_type","<=")!="<=": raise RuntimeError("categorical split unsupported")
    return {"f":int(node["split_feature"]),"t":float(node["threshold"]),"d":bool(node.get("default_left",True)),
            "l":compact(node["left_child"]),"r":compact(node["right_child"])}

def eval_tree(node,x):
    while "v" not in node:
        v=x[node["f"]]
        go=node["d"] if not np.isfinite(v) else v<=node["t"]
        node=node["l"] if go else node["r"]
    return node["v"]

def export_head(model,cal=None):
    booster=model.booster_; dump=booster.dump_model(); trees=[compact(t["tree_structure"]) for t in dump["tree_info"]]
    probe=Xv[:min(64,len(Xv))]
    raw=np.asarray(booster.predict(probe,raw_score=True),dtype=float)
    summed=np.asarray([sum(eval_tree(t,x) for t in trees) for x in probe],dtype=float)
    offset=float(np.mean(raw-summed)); err=float(np.max(np.abs(raw-(summed+offset))))
    if err>1e-5: raise RuntimeError(f"tree export mismatch {err}")
    out={"kind":"lgbm","baseScore":offset,"trees":trees}
    if cal is not None: out["calibration"]=cal
    return out

direction_models={}; direction_heads={}
for h in (15,30,60,120):
    m,cal=fit_classifier(lambda r,h=h: int(r["ret"][str(h)]>0))
    direction_models[h]=m; direction_heads[str(h)]=export_head(m,cal)
return_models={}; return_heads={}
for h in (15,30,60,120):
    m=fit_regressor(lambda r,h=h: float(r["ret"][str(h)]))
    return_models[h]=m; return_heads[str(h)]=export_head(m)
mfe=fit_regressor(lambda r:float(r["longMfe"])); mae=fit_regressor(lambda r:float(r["longMae"]))
reg_l=fit_regressor(lambda r:float(r["longRegret"]),objective="regression_l1")
reg_s=fit_regressor(lambda r:float(r["shortRegret"]),objective="regression_l1")
touch_l,touch_l_cal=fit_touch("longTouch"); touch_s,touch_s_cal=fit_touch("shortTouch")

def calibrated(model,cal,X):
    raw=np.asarray(model.booster_.predict(X,raw_score=True),dtype=float)
    z=np.clip(cal["a"]*raw+cal["b"],-40,40); return 1/(1+np.exp(-z))
def pred_reg(model,X): return np.asarray(model.predict(X),dtype=float)

pv={h:calibrated(direction_models[h],direction_heads[str(h)]["calibration"],Xv) for h in (15,30,60,120)}
pt={h:calibrated(direction_models[h],direction_heads[str(h)]["calibration"],Xt) for h in (15,30,60,120)}
rv={h:pred_reg(return_models[h],Xv) for h in (15,30,60,120)}
rt={h:pred_reg(return_models[h],Xt) for h in (15,30,60,120)}
lmv=np.maximum(0,pred_reg(mfe,Xv)); lav=np.maximum(0,pred_reg(mae,Xv)); smv=lav; sav=lmv
lmt=np.maximum(0,pred_reg(mfe,Xt)); lat=np.maximum(0,pred_reg(mae,Xt)); smt=lat; sat=lmt
tlv=calibrated(touch_l,touch_l_cal,Xv); tsv=calibrated(touch_s,touch_s_cal,Xv)
tlt=calibrated(touch_l,touch_l_cal,Xt); tst=calibrated(touch_s,touch_s_cal,Xt)
rlv=np.maximum(0,pred_reg(reg_l,Xv)); rsv=np.maximum(0,pred_reg(reg_s,Xv))
rlt=np.maximum(0,pred_reg(reg_l,Xt)); rst=np.maximum(0,pred_reg(reg_s,Xt))

def views(ps,rs,lm,la,sm,sa,tl,ts,rl,rr):
    dl=.45*ps[60]+.35*ps[120]+.20*ps[30]; ds=1-dl
    lev=.5*(rs[60]-COST)+.3*(lm-la-COST)+.2*(tl-.5)*.01-rl*.35
    sev=.5*(-rs[60]-COST)+.3*(sm-sa-COST)+.2*(ts-.5)*.01-rr*.35
    return dl,ds,lev,sev
dlv,dsv,levv,sevv=views(pv,rv,lmv,lav,smv,sav,tlv,tsv,rlv,rsv)
dlt,dst,levt,sevt=views(pt,rt,lmt,lat,smt,sat,tlt,tst,rlt,rst)

def policy_stats(rows,dl,ds,lev,sev,tl,ts,rl,rr,policy):
    trades=wins=longs=shorts=0; total=gw=gl=0.0
    for i,r in enumerate(rows):
        side=0
        if lev[i]>=policy["minNetEv"] and dl[i]>=policy["directionMin"] and tl[i]>=policy["touchMin"] and rl[i]<=policy["regretMax"]: side=1
        elif sev[i]>=policy["minNetEv"] and ds[i]>=policy["directionMin"] and ts[i]>=policy["touchMin"] and rr[i]<=policy["regretMax"]: side=-1
        if not side: continue
        net=side*float(r["ret"]["60"])-COST; trades+=1; total+=net
        if side>0: longs+=1
        else: shorts+=1
        if net>0: wins+=1; gw+=net
        else: gl-=net
    pf=gw/gl if gl>0 else (99.0 if gw>0 else 0.0)
    return {"trades":trades,"avgNet60":total/max(1,trades),"winRate":wins/max(1,trades),"profitFactor":pf,
            "coverage":trades/max(1,len(rows)),"long":longs,"short":shorts}

candidates=[]
for dm in (.52,.54,.56,.58,.60,.62,.64):
  for tm in (.34,.38,.42,.46,.50,.54,.58):
    for rg in (.0015,.0025,.0035,.005,.007):
      for ev in (0,.00025,.0005,.001,.0015):
        p={"directionMin":dm,"touchMin":tm,"regretMax":rg,"minNetEv":ev,"minSources":2,"maxDisagreement":.015}
        s=policy_stats(valid,dlv,dsv,levv,sevv,tlv,tsv,rlv,rsv,p)
        if s["trades"]<max(250,int(len(valid)*.008)) or s["avgNet60"]<=0 or s["profitFactor"]<=1: continue
        score=s["avgNet60"]*math.sqrt(s["trades"])*min(1.6,s["profitFactor"])
        candidates.append((score,p,s))
if not candidates: raise RuntimeError("No positive validation entry policy")
candidates.sort(key=lambda x:(x[0],x[2]["trades"]),reverse=True)
_,policy,vstats=candidates[0]
tstats=policy_stats(test,dlt,dst,levt,sevt,tlt,tst,rlt,rst,policy)
if tstats["trades"]<100 or tstats["avgNet60"]<=0 or tstats["profitFactor"]<=1.03:
    raise RuntimeError("Untouched test gate failed "+json.dumps(tstats))

metrics={"trainSamples":len(train),"validationSamples":len(valid),"testSamples":len(test),"totalSamples":len(rows),
         "policyValidationTrades":vstats["trades"],"policyValidationAvgNet60":vstats["avgNet60"],"policyValidationWinRate":vstats["winRate"],
         "policyValidationProfitFactor":vstats["profitFactor"],"policyTestTrades":tstats["trades"],"policyTestAvgNet60":tstats["avgNet60"],
         "policyTestWinRate":tstats["winRate"],"policyTestProfitFactor":tstats["profitFactor"],"policyTestCoverage":tstats["coverage"],
         "policyTestLong":tstats["long"],"policyTestShort":tstats["short"]}
for h in (15,30,60,120):
    y=np.asarray([int(r["ret"][str(h)]>0) for r in test])
    metrics[f"directionBrier{h}"]=float(brier_score_loss(y,pt[h]))
    metrics[f"directionAccuracy{h}"]=float(accuracy_score(y,pt[h]>=.5))
    metrics[f"returnMae{h}"]=float(mean_absolute_error([r["ret"][str(h)] for r in test],rt[h]))
metrics["longMfeMae"]=float(mean_absolute_error([r["longMfe"] for r in test],lmt))
metrics["longMaeMae"]=float(mean_absolute_error([r["longMae"] for r in test],lat))
metrics["longRegretMae"]=float(mean_absolute_error([r["longRegret"] for r in test],rlt))
metrics["shortRegretMae"]=float(mean_absolute_error([r["shortRegret"] for r in test],rst))

artifact={"version":"predictive-path-v1","trainedAt":int(time.time()*1000),
          "source":"gate-official-5m+gate-stats-funding-premium+lightgbm",
          "featureNames":names,"costRate":COST,"horizons":[15,30,60,120],
          "direction":direction_heads,"expectedReturn":return_heads,
          "longMfe60":export_head(mfe),"longMae60":export_head(mae),"shortMfe60":export_head(mae),"shortMae60":export_head(mfe),
          "longTargetBeforeRisk60":export_head(touch_l,touch_l_cal),"shortTargetBeforeRisk60":export_head(touch_s,touch_s_cal),
          "longEntryRegret10":export_head(reg_l),"shortEntryRegret10":export_head(reg_s),"policy":policy,"metrics":metrics}
with open(OUTPUT,"w",encoding="utf-8") as f: json.dump(artifact,f,separators=(",",":"))
print(json.dumps({"output":OUTPUT,"policy":policy,"metrics":metrics,"features":feature_count},indent=2))
