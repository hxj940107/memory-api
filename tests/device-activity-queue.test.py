"""Execute the generated control flow against an in-memory file provider/HTTP stub.

This verifies queue invariants, not Apple's native serialization or permissions.
"""
import datetime as dt
from pathlib import Path
import runpy
import unittest

B = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/build-device-activity-clean-queue.py'))
B['validate']()
A = B['workflow']['WFWorkflowActions']

class Halt(Exception): pass

class Files:
    def __init__(self, path): self.path=path

class Runtime:
    def __init__(self, signal='抖音｜打开', response='accepted', inject=False, recent=False):
        self.signal=signal; self.response=response; self.inject=inject
        self.now=dt.datetime(2026,10,27,12,0,0,tzinfo=dt.timezone.utc)
        self.fs={'xiaoc-activity-upload-token.txt':'TEST_ONLY_NOT_A_REAL_CREDENTIAL'}
        self.modified={}; self.outputs={}; self.variables={}; self.requests=0; self.deleted=[]; self.random=1000
        self.fs['xiaoc-activity.txt']='legacy log must remain untouched'
        self.fs['xiaoc-activity-upload-state.txt']='legacy state must remain untouched'
        if recent:
            self.fs[B['ATTEMPT']]='previous attempt'
            self.modified[B['ATTEMPT']]=self.now
    def resolve(self, x):
        if not isinstance(x,dict): return x
        if x.get('Type')=='Variable' and 'Variable' in x: return self.resolve(x['Variable'])
        value=x.get('Value',x)
        if x.get('WFSerializationType')=='WFTextTokenString':
            string=value['string']; parts=[]
            for index,ch in enumerate(string):
                parts.append(self.as_text(self.resolve(value['attachmentsByRange']['{%d, 1}'%index])) if ch=='\ufffc' else ch)
            return ''.join(parts)
        if value.get('Type')=='ActionOutput':return self.outputs[value['OutputUUID']]
        if value.get('Type')=='Variable':return self.variables[value['VariableName']]
        if value.get('Type')=='ExtensionInput':return self.signal
        return value
    def as_text(self,x):
        if isinstance(x,Files):return self.fs[x.path]
        if isinstance(x,list):return '\n'.join(self.as_text(v) for v in x)
        return str(x) if x is not None else ''
    def run(self):
        try:self.execute(0,len(A))
        except Halt:pass
        return self
    def execute(self,start,end):
        i=start;last=None
        while i<end:
            a=A[i];p=a['WFWorkflowActionParameters'];name=a['WFWorkflowActionIdentifier'].removeprefix('is.workflow.actions.')
            if name in ('conditional','repeat.each'):
                group=p['GroupingIdentifier'];j=next(j for j in range(i+1,end) if A[j]['WFWorkflowActionParameters'].get('GroupingIdentifier')==group and A[j]['WFWorkflowActionParameters'].get('WFControlFlowMode')==2)
                if name=='conditional':
                    value=self.resolve(p['WFInput']);code=p['WFCondition'];operand=self.resolve(p.get('WFNumberValue',p.get('WFConditionalActionString')))
                    yes={100:lambda:bool(value),101:lambda:not bool(value),0:lambda:float(value)<float(operand),1:lambda:float(value)<=float(operand),2:lambda:float(value)>float(operand),4:lambda:self.as_text(value)==self.as_text(operand)}[code]()
                    if yes:self.execute(i+1,j)
                else:
                    result=[]
                    for item in self.resolve(p['WFInput']):
                        self.variables['Repeat Item']=item;result.append(self.execute(i+1,j))
                    self.outputs[A[j]['WFWorkflowActionParameters']['UUID']]=result
                i=j+1;continue
            r=None
            if name=='exit':raise Halt()
            elif name=='gettext':r=self.resolve(p['WFTextActionText'])
            elif name=='file.createfolder':r=Files(p['WFFilePath'])
            elif name=='file.getfoldercontents':
                prefix=self.resolve(p['WFFolder']).path+'/'
                r=[Files(k) for k in self.fs if k.startswith(prefix)]
            elif name=='text.match':
                import re
                r=re.findall(p['WFMatchTextPattern'],self.resolve(p['text']))
            elif name=='date':r=self.now
            elif name=='format.date':r=self.resolve(p['WFDate']) # Native formatter resolved below.
            elif name=='number.random':self.random+=1;r=self.random
            elif name=='number':r=p['WFNumberActionNumber']
            elif name=='documentpicker.save':
                path=self.resolve(p['WFFileDestinationPath']);data=self.as_text(self.resolve(p['WFInput']))
                assert p['WFSaveFileOverwrite'] or path not in self.fs
                self.fs[path]=data;self.modified[path]=self.now;r=Files(path)
            elif name=='documentpicker.open':r=Files(p['WFGetFilePath']) if p['WFGetFilePath'] in self.fs else None
            elif name=='properties.files':r=self.modified[self.resolve(p['WFInput']).path]
            elif name=='gettimebetweendates':
                # Text token strings contain native Dates at runtime, not Python's repr.
                left=next(iter(p['WFTimeUntilFromDate']['Value']['attachmentsByRange'].values()))
                right=next(iter(p['WFInput']['Value']['attachmentsByRange'].values()))
                r=(self.resolve(right)-self.resolve(left)).total_seconds()
            elif name=='count':r=len(self.resolve(p['Input']))
            elif name=='setvariable':r=self.resolve(p['WFInput']);self.variables[p['WFVariableName']]=r
            elif name=='getitemfromlist':r=self.resolve(p['WFInput'])[int(self.resolve(p['WFItemRangeStart']))-1:int(self.resolve(p['WFItemRangeEnd']))]
            elif name=='detect.text':r=self.as_text(self.resolve(p['WFInput']))
            elif name=='text.combine':r='\n'.join(self.resolve(p['text']))
            elif name=='downloadurl':
                self.requests+=1
                if self.inject:self.fs[B['QUEUE']+'/new-during-request.txt']='new event, not in snapshot'
                if self.response=='exception':raise OSError('simulated network failure')
                size=self.outputs[B['batch_count']]
                r={'status':self.response,'received_lines':size if self.response!='wrong_count' else 0}
                if self.response=='wrong_count':r['status']='accepted'
            elif name=='getvalueforkey':r=self.resolve(p['WFInput']).get(p['WFDictionaryKey'],'')
            elif name=='file.delete':
                for f in self.resolve(p['WFInput']):self.fs.pop(f.path,None);self.deleted.append(f.path)
            elif name not in ('comment','showresult'):raise AssertionError(name)
            if name=='format.date':
                pattern=p['WFDateFormatString']
                r=self.now.strftime('%Y-%m-%d %H:%M:%S') if pattern=='yyyy-MM-dd HH:mm:ss' else ('20261027120000000' if pattern=='yyyyMMddHHmmssSSS' else self.now.isoformat())
            self.outputs[p['UUID']]=r;last=r;i+=1
        return last

class QueueTests(unittest.TestCase):
    def test_confirmed_snapshot_only_is_removed(self):
        r=Runtime(inject=True).run()
        self.assertEqual(r.requests,1)
        self.assertEqual(len(r.deleted),1)
        self.assertIn(B['QUEUE']+'/new-during-request.txt',r.fs)
        self.assertEqual(r.fs['xiaoc-activity.txt'],'legacy log must remain untouched')
    def test_failure_throttle_wrong_count_do_not_delete(self):
        for status in ('throttled','wrong_count'):
            r=Runtime(response=status).run();self.assertFalse(r.deleted)
            self.assertTrue(any(k.startswith(B['QUEUE']+'/') for k in r.fs))
        r=Runtime(response='exception')
        with self.assertRaises(OSError):r.run()
        self.assertFalse(r.deleted)
    def test_five_minute_gate_keeps_new_capture(self):
        r=Runtime(recent=True).run();self.assertEqual(r.requests,0)
        self.assertTrue(any(k.startswith(B['QUEUE']+'/') for k in r.fs))
    def test_manual_no_input_does_not_capture_upload_or_delete(self):
        r=Runtime(signal='').run();self.assertEqual(r.requests,0);self.assertFalse(r.deleted)
        self.assertFalse(any(k.startswith(B['QUEUE']+'/') for k in r.fs))
    def test_invalid_input_is_not_persisted(self):
        r=Runtime(signal='抖音｜打开\nmalicious').run();self.assertEqual(r.requests,0)
        self.assertFalse(any(k.startswith(B['QUEUE']+'/') for k in r.fs))
    def test_batch_limit_preserves_rest(self):
        r=Runtime()
        for i in range(350):r.fs[B['QUEUE']+f'/prior-{i}.txt']='2026-10-27 19:00:00 | 抖音 | 打开'
        r.run();self.assertEqual(len(r.deleted),300)
        self.assertEqual(sum(k.startswith(B['QUEUE']+'/') for k in r.fs),51)

if __name__=='__main__':unittest.main()
