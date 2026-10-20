import unittest, importlib.util, pathlib, tempfile, json, hashlib
spec=importlib.util.spec_from_file_location('candidate',pathlib.Path(__file__).with_name('real-base-candidate.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_real_host_temporary_path_strict_publisher(self):
  # Real host tempfile convention (/var -> /private/var on macOS), real
  # publisher, no patched safety checks. Synthetic base is test-only.
  repo=pathlib.Path(__file__).resolve().parents[1]
  publisher=m.load_module('strict_publisher_regression',repo.parent/'pilot-images/host/inventory.py')
  with tempfile.TemporaryDirectory(prefix='real-base-publisher-regression-') as d:
   lexical=pathlib.Path(d);root=lexical.resolve()
   base=root/'vms'/'test-base';base.mkdir(parents=True)
   for name in ('config.json','disk.img','nvram.bin'):(base/name).write_bytes(b'regression fixture')
   raw=root/'raw.json';raw.write_text(json.dumps(dict(schemaVersion=1,os='linux',architecture='arm64',collectedAt='2026-09-13T00:00:00Z',sources=[dict(id='fixture',status='unavailable')],applications=[])))
   collector=root/'collect.py';collector.write_text('# regression fixture\n')
   aliases=root/'aliases.json';aliases.write_text('{}')
   output=root/'pilot/inventories/local/base/ubuntu2404.json';portable=root/'pilot/inventories/ubuntu2404.json'
   if any(p.is_symlink() for p in (lexical,*lexical.parents)):
    with self.assertRaisesRegex(ValueError,'symlink path refused'):
     publisher.bind(raw,lexical/'pilot/inventories/local/base/ubuntu2404.json',root/'vms','test-base','ubuntu2404','linux',portable=portable)
   result=publisher.bind(raw,output,root/'vms','test-base','ubuntu2404','linux',portable=portable,mode='disposable-clone',evidence_id='temporary-path-regression',collector=collector,aliases=aliases)
   self.assertEqual(publisher.verify(publisher.read_json(output),root/'vms','test-base','ubuntu2404','linux',portable),result)
   self.assertEqual(result['base']['path'],str(base))
   # Strict symlink rejection remains enforced even after caller canonicalizes.
   link=root/'alias';link.symlink_to(root/'pilot',target_is_directory=True)
   with self.assertRaisesRegex(ValueError,'symlink path refused'):publisher.safe(link/'inventories/ubuntu2404.json')
  self.assertFalse(root.exists())
 def test_routes(self):
  for p in ('/gc','/machines/foreign/release','/machines/owned/delete','/applications'):
   self.assertFalse(m.admitted('POST',p,{},'owned',True))
  self.assertFalse(m.admitted('GET','/applications',{},'owned',True))
  for a in ('exec','push','pull','heartbeat','release'):
   self.assertTrue(m.admitted('POST','/machines/owned/'+a,{},'owned',True))
 def test_one_acquire(self):
  # Manager contract: `relay-${input.task}-${randomUUID().slice(0, 8)}`.
  b=dict(image='ubuntu2404',env='none',purpose='relay-real-base-chain-a8f394ab')
  manager=(pathlib.Path(__file__).resolve().parents[1]/'src/manager.ts').read_text()
  self.assertIn('`relay-${input.task}-${randomUUID().slice(0, 8)}`',manager)
  for purpose in ('real-base-chain-a8f394ab','relay-real-base-chain-123','relay-real-base-chain-a8f394ab-extra','relay-foreign-a8f394ab'):
   self.assertFalse(m.admitted('POST','/acquire',dict(b,purpose=purpose),None,False))
  self.assertTrue(m.admitted('POST','/acquire',b,None,False))
  self.assertFalse(m.admitted('POST','/acquire',b,'owned',True))
  for k in b:
   c=dict(b);c[k]='foreign';self.assertFalse(m.admitted('POST','/acquire',c,None,False))
 def test_preflight_fails_closed(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);(r/'ubuntu2404').mkdir();fp={'files':{'disk.img':{'st_ino':1}}}
   for n in ('before-fingerprint.json','after-fingerprint.json'):(r/'ubuntu2404'/n).write_text(json.dumps(fp))
   (r/'collect.py').write_text('original')
   (r/'sha256.json').write_text(json.dumps({'collect.py':m.digest(r/'collect.py')}))
   p=type('Publisher',(),{'fingerprint':staticmethod(lambda *a:fp)})
   self.assertTrue(m.check_original(r,p,r)['matches'])
   (r/'collect.py').write_text('tampered');self.assertFalse(m.check_original(r,p,r)['matches'])
   (r/'collect.py').write_text('original');p.fingerprint=lambda *a:{'changed':True}
   self.assertFalse(m.check_original(r,p,r)['matches'])
if __name__=='__main__':unittest.main()
