from pathlib import Path
import base64,bz2,hashlib,json
root=Path.cwd().resolve()
packed=''.join((root/f'scripts/ui-records-ready-{i}.b64').read_text().strip() for i in (1,2))
assert len(packed)==21388,f'Payload length mismatch: {len(packed)}'
assert hashlib.sha256(packed.encode()).hexdigest()=='c2292c4a3e79ccfb75f95467e1369df3c204738379a96f806cb30496a75b2356','Payload checksum mismatch'
items=json.loads(bz2.decompress(base64.b64decode(packed,validate=True)))
assert len(items)==23
ready=[]
for item in items:
    p=(root/item['path']).resolve()
    assert p.is_relative_to(root) and '.git' not in p.relative_to(root).parts
    old=p.read_bytes() if p.exists() else b''
    assert hashlib.sha256(old).hexdigest()==item['before'],'Base mismatch: '+item['path']
    text=old.decode()
    for a,b,part in reversed(item['edits']):
        assert 0<=a<=b<=len(text)
        text=text[:a]+part+text[b:]
    out=text.encode()
    assert hashlib.sha256(out).hexdigest()==item['after'],'Target mismatch: '+item['path']
    ready.append((p,out,item['after']))
for p,out,digest in ready:
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(out)
    print('VERIFIED',str(p.relative_to(root)),digest)
Path('/tmp/ui-records-publication').mkdir(exist_ok=True)
Path('/tmp/ui-records-publication/package-files.json').write_text(json.dumps([{'path':i['path'],'before':i['before'],'after':i['after']} for i in items],indent=2))
