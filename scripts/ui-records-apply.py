from pathlib import Path
import base64,bz2,hashlib,json
root=Path.cwd().resolve()
packed=''.join((root/f'scripts/ui-records-transfer-{i}.b64').read_text().strip() for i in (1,2))
assert len(packed)==25872,f'Payload length mismatch: {len(packed)}'
assert hashlib.sha256(packed.encode()).hexdigest()=='d731ee41c40d0992fe8cd5aa2426bd0ef05e7f9be0d0b7e6ab58919145ad5030','Payload hash mismatch'
manifest=json.loads(bz2.decompress(base64.b64decode(packed,validate=True)))
assert len(manifest)==22
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
