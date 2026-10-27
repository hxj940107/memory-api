"""Native Shortcuts collector with immutable per-event files and receipt-only cleanup.

Does not compact the legacy append log: its independent writer cannot be locked by
an uploader. Replace the common collector when adopting this candidate.
"""
from pathlib import Path
import plistlib
import runpy

b = runpy.run_path(str(Path(__file__).with_name('build-device-activity-shortcut.py')))
actions = b['actions']; actions.clear()
add, ref, text, uid = (b[k] for k in ('add', 'ref', 'text', 'uid'))
if_start, end, stop, getkey, getfile = (b[k] for k in ('if_start', 'end', 'stop', 'getkey', 'getfile'))
field, fields = b['field'], b['fields']
QUEUE = 'xiaoc-activity-pending'
ATTEMPT = 'xiaoc-activity-queue-attempt.txt'

def save(source, path, overwrite):
    return add('documentpicker.save', WFInput=ref(source), WFAskWhereToSave=False,
               WFFileDestinationPath=path, WFSaveFileOverwrite=overwrite,
               WFFileStorageService='iCloud Drive')

def count(source): return add('count', Input=ref(source), WFInput=ref(source), WFCountType='Items')
def variable(name): return {'Value':{'Type':'Variable','VariableName':name}, 'WFSerializationType':'WFTextTokenAttachment'}
def format_date(source, pattern):
    return add('format.date', WFDate=text(ref(source)), WFDateFormatStyle='Custom',
               WFDateFormat='Custom', WFDateFormatString=pattern)

add('comment', WFCommentActionText='本地自动清理候选：只处理Shortcuts/xiaoc-activity-pending内的新活动文件。每个事件独立存储，后端确认整批后只删除本批快照；上传中产生的新文件不会被删除。旧日志/旧进度/凭证不删除。无输入手动运行仅检查队列，不上传；自动化输入才记录及尝试上传。首次文件访问/删除仍可能需要iOS授权。')
incoming = add('detect.text', WFInput={'Value':{'Type':'ExtensionInput'}, 'WFSerializationType':'WFTextTokenAttachment'})
folder = add('file.createfolder', WFFilePath=QUEUE, WFFileStorageService='iCloud Drive')

# No input: provide an honest non-network setup check, without synthetic activity.
g = if_start(incoming, 101)
queued = add('file.getfoldercontents', WFFolder=ref(folder), WFGetFolderContentsRecursive=False)
queued_count = count(queued)
add('showresult', Text=text('本地队列已就绪。当前待上传文件：',ref(queued_count),'。\n本次没有输入活动，不上传、不删除记录。接入前请先保留旧版。'))
stop(); end(g)

valid = add('text.match', text=text(ref(incoming)), WFMatchTextPattern=r'^\s*(小红书|抖音|淘宝)\s*[|｜]\s*(打开|离开)\s*$', WFMatchTextCaseSensitive=True)
g = if_start(valid, 101)
add('showresult', Text=text('未识别到有效App活动输入，未写入、未上传、未清理。\n实际收到：【',ref(incoming),'】\n预期示例：小红书 | 打开'))
stop(); end(g)
now = add('date', WFDateActionMode='Current Date')
event_time = format_date(now, 'yyyy-MM-dd HH:mm:ss')
# Names have millisecond time plus two independent random components. Never
# overwrite on collision; any file provider rename still preserves both events.
file_time = format_date(now, 'yyyyMMddHHmmssSSS')
r1 = add('number.random', WFRandomNumberMinimum=1, WFRandomNumberMaximum=2147483647)
r2 = add('number.random', WFRandomNumberMinimum=1, WFRandomNumberMaximum=2147483647)
path = text(QUEUE+'/',ref(file_time),'-',ref(r1),'-',ref(r2),'.txt')
line = add('gettext', WFTextActionText=text(ref(event_time),' | ',ref(incoming)))
save(line, path, False)

# Best-effort device throttle, backed by the existing transactional server gate.
attempt_file = add('documentpicker.open', WFGetFilePath=ATTEMPT, WFShowFilePicker=False,
                   WFFileErrorIfNotFound=False, WFFileStorageService='iCloud Drive')
g = if_start(attempt_file, 100)
previous = add('properties.files', WFInput=ref(attempt_file), WFContentItemPropertyName='Last Modified Date')
elapsed = add('gettimebetweendates', WFTimeUntilFromDate=text(ref(previous)), WFInput=text(ref(now)), WFTimeUntilUnit='Seconds')
h = if_start(elapsed, 0, 300); stop(); end(h); end(g)

all_files = add('file.getfoldercontents', WFFolder=ref(folder), WFGetFolderContentsRecursive=False)
total = count(all_files)
g = if_start(total, 0, 1); stop(); end(g)
add('setvariable', WFVariableName='QueueBatchEnd', WFInput=ref(total))
g = if_start(total, 2, 300)
limit = add('number', WFNumberActionNumber=300)
add('setvariable', WFVariableName='QueueBatchEnd', WFInput=ref(limit)); end(g)
batch = add('getitemfromlist', WFInput=ref(all_files), WFItemSpecifier='Items in Range',
            WFItemRangeStart=1, WFItemRangeEnd=variable('QueueBatchEnd'))
# Keep exactly this immutable File-object list for deletion after receipt.
group = uid()
add('repeat.each', WFInput=ref(batch), GroupingIdentifier=group, WFControlFlowMode=0)
add('detect.text', WFInput=variable('Repeat Item'))
contents = add('repeat.each', GroupingIdentifier=group, WFControlFlowMode=2)
log = add('text.combine', text=ref(contents), WFTextSeparator='New Lines')
batch_count = count(batch)
expected_count = add('gettext', WFTextActionText=text(ref(batch_count)))
token_file = getfile('xiaoc-activity-upload-token.txt')
token = add('detect.text', WFInput=ref(token_file))
stamp = format_date(now, "yyyy-MM-dd'T'HH:mm:ssXXXXX")
save(stamp, ATTEMPT, True)
response = add('downloadurl', WFURL='https://memory-api-beta.vercel.app/api/user-state?action=upload-device-activity',
               WFHTTPMethod='POST', WFHTTPBodyType='JSON',
               WFHTTPHeaders=fields(field('x-xiaoc-activity-token',text(ref(token)))),
               WFJSONValues=fields(field('log',text(ref(log)))))
status = getkey(response,'status')
status_text = add('gettext', WFTextActionText=text(ref(status)))
g = if_start(status_text,4,'accepted')
received = getkey(response,'received_lines')
received_text = add('gettext', WFTextActionText=text(ref(received)))
h = if_start(received_text,4,text(ref(expected_count)))
add('file.delete', WFInput=ref(batch), WFDeleteFileConfirmDeletion=False)
end(h); end(g)

workflow = {**b['workflow'], 'WFWorkflowName':'小C感知测试',
            'WFWorkflowActions':actions, 'WFWorkflowHasShortcutInputVariables':True,
            'WFWorkflowInputContentItemClasses':['WFStringContentItem'],
            'WFWorkflowNoInputBehavior':{'Name':'WFWorkflowNoInputBehaviorContinue','Parameters':{}}}

def validate():
    ids={a['WFWorkflowActionParameters']['UUID'] for a in actions}
    def visit(v):
        if isinstance(v,dict):
            if 'OutputUUID' in v: assert v['OutputUUID'] in ids
            for x in v.values(): visit(x)
        elif isinstance(v,list):
            for x in v: visit(x)
    visit(workflow)
    deletes=[a for a in actions if a['WFWorkflowActionIdentifier'].endswith('.file.delete')]
    assert len(deletes)==1 and deletes[0]['WFWorkflowActionParameters']['WFInput']==ref(batch)
    assert not any(a['WFWorkflowActionIdentifier'].endswith('.file.append') for a in actions)
    for a in actions:
        p=a['WFWorkflowActionParameters']
        if a['WFWorkflowActionIdentifier'].endswith('.documentpicker.save'):
            destination=p['WFFileDestinationPath']
            assert destination==ATTEMPT or (isinstance(destination,dict) and destination['Value']['string'].startswith(QUEUE+'/'))

if __name__=='__main__':
    validate()
    out=b['OUT'];out.mkdir(parents=True,exist_ok=True)
    for fmt,name in [(plistlib.FMT_XML,'queue-source.plist'),(plistlib.FMT_BINARY,'queue-unsigned.shortcut')]:
        with (out/name).open('wb') as f:plistlib.dump(workflow,f,fmt=fmt)
    print(f'Queue collector generated: {len(actions)} actions; receipt + count guarded snapshot deletion; no credential embedded.')
