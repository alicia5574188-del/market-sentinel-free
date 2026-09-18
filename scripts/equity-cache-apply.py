from pathlib import Path
import base64,bz2,hashlib,json
root=Path.cwd().resolve()
packed=(root/'scripts/equity-cache-transfer.b64').read_text().strip()
# Repair the one identified transport typo, then still require the ORIGINAL
# independent full-payload and every before/after source digest.
if 'RSTpJ8+u33Ty' in packed:
    assert packed.count('RSTpJ8+u33Ty')==1
    packed=packed.replace('RSTpJ8+u33Ty','RSTpJ8+33Ty')
    print('Corrected identified single-character transport insertion')
assert len(packed)==17964, f'Payload length mismatch: {len(packed)}'
assert hashlib.sha256(packed.encode()).hexdigest()=='b21cc4721f6ac011664cefa88507fd8676c337c7ca33f423b4d0fb045eadf1e3','Payload hash mismatch'
manifest=json.loads(bz2.decompress(base64.b64decode(packed,validate=True)))
assert len(manifest)==15
prepared=[]
for item in manifest:
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
    prepared.append((p,new,item['after']))
for p,new,digest in prepared:
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(new)
    print('VERIFIED',str(p.relative_to(root)),digest)
