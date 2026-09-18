from pathlib import Path
import base64,bz2,hashlib,json
root=Path.cwd().resolve()
packed=''.join((root/f'scripts/copy-gap-transfer-{i}.b64').read_text().strip() for i in (1,2))
# Repair one transport-only duplicate character, then verify the complete
# independently generated source payload. No source is written on mismatch.
if len(packed)==22449 and packed.count('Xppp2Aw')==1:packed=packed.replace('Xppp2Aw','Xpp2Aw',1)
assert len(packed)==22448, f'Payload length mismatch: {len(packed)}'
assert hashlib.sha256(packed.encode()).hexdigest()=='2e318342662e6cfea2ef8e5c0d06b5edb45d9490b0b32e6034a2a25e9e0ffb57','Payload hash mismatch'
items=json.loads(bz2.decompress(base64.b64decode(packed,validate=True)))
assert len(items)==19
ready=[]
for item in items:
    p=(root/item['path']).resolve()
    assert p.is_relative_to(root) and '.git' not in p.relative_to(root).parts
    old=p.read_bytes() if p.exists() else b''
    assert hashlib.sha256(old).hexdigest()==item['before'],'Base mismatch: '+item['path']
    lines=old.decode().splitlines(keepends=True)
    for start,end,text in reversed(item['edits']):
        assert 0<=start<=end<=len(lines)
        lines[start:end]=[text]
    new=''.join(lines).encode()
    assert hashlib.sha256(new).hexdigest()==item['after'],'Target mismatch: '+item['path']
    ready.append((p,new,item['after']))
for p,new,digest in ready:
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(new)
    print('VERIFIED',str(p.relative_to(root)),digest)
