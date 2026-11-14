import unittest, importlib.util, pathlib, tempfile, json, hashlib
spec=importlib.util.spec_from_file_location('candidate',pathlib.Path(__file__).with_name('real-base-candidate.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
publisher_source=pathlib.Path(__file__).resolve().parents[1].parent/'pilot-images/host/inventory.py'
class Tests(unittest.TestCase):
 @unittest.skipUnless(publisher_source.exists(),f'no sibling pilot-images checkout at {publisher_source.parent.parent}')
 def test_real_host_temporary_path_strict_publisher(self):
  # Real host tempfile convention (/var -> /private/var on macOS), real
  # publisher, no patched safety checks. Synthetic base is test-only.
  publisher=m.load_module('strict_publisher_regression',publisher_source)
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
 def test_catalog_only_under_a_marked_instance_root(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d).resolve()/'instance';root.mkdir()
   store=str(pathlib.Path(d).resolve()/'home/.tart')
   env=dict(MACHINE_SERVICE_SECOND_INSTANCE='ab12',TART_HOME=store,TART_NO_AUTO_PRUNE='1',PILOT_REPO=str(root/'candidate/pilot'),PILOT_IMAGES_STATE_DIR=str(root/'candidate/image-state'))
   good=dict(id='ab12',root=str(root),tart_home=store,env=env)
   catalog=m.instance_catalog(good,root)
   self.assertEqual(catalog['pilot'],root/'candidate/pilot');self.assertEqual(catalog['store'],pathlib.Path(store))
   for patch,refusal in [
    (dict(env={**env,'MACHINE_SERVICE_SECOND_INSTANCE':'ffff'}),'no marked second instance'),
    (dict(env={k:v for k,v in env.items() if k!='MACHINE_SERVICE_SECOND_INSTANCE'}),'no marked second instance'),
    (dict(env=None),'no marked second instance'),
    (dict(root=d),'another root'),
    (dict(env={**env,'TART_NO_AUTO_PRUNE':'0'}),'auto-prune off'),
    (dict(env={**env,'TART_HOME':'/elsewhere'}),'auto-prune off'),
    (dict(env={k:v for k,v in env.items() if k!='PILOT_REPO'}),'names no PILOT_REPO'),
    (dict(env={**env,'PILOT_REPO':str(pathlib.Path(d).resolve()/'pilot-images')}),'outside the instance root'),
    (dict(env={**env,'PILOT_IMAGES_STATE_DIR':str(root)}),'outside the instance root'),
    (dict(env={**env,'PILOT_REPO':'relative'}),'names no PILOT_REPO'),
   ]:
    with self.assertRaisesRegex(ValueError,refusal,msg=str(patch)):m.instance_catalog({**good,**patch},root)
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
 def test_no_proxy_and_no_installed_instance(self):
  source=pathlib.Path(__file__).with_name('real-base-candidate.py').read_text()
  for gone in ('6240','urlopen','HTTPServer','/opt/homebrew','.tart/vms'):self.assertNotIn(gone,source)
if __name__=='__main__':unittest.main()
