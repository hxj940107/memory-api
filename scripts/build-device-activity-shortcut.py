"""Build a native iPhone Shortcuts candidate; signing is a separate system operation.

No credentials are embedded. Preview is the default and never updates upload state.
File names match the user's verified .txt files, regardless of their JSON content.
"""
import plistlib
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'artifacts/device-activity-shortcuts'
actions = []

def uid(): return str(uuid.uuid4()).upper()

def add(identifier, **params):
    identifier = 'is.workflow.actions.' + identifier
    value = uid()
    actions.append({'WFWorkflowActionIdentifier': identifier,
                    'WFWorkflowActionParameters': {'UUID': value, **params}})
    return value

def ref(value, name='Result'):
    return {'Value': {'Type': 'ActionOutput', 'OutputUUID': value, 'OutputName': name},
            'WFSerializationType': 'WFTextTokenAttachment'}

def text(*parts):
    value, attachments = '', {}
    for part in parts:
        if isinstance(part, dict):
            attachments['{%d, 1}' % (len(value.encode('utf-16-le')) // 2)] = part['Value']
            value += '\ufffc'
        else: value += str(part)
    return {'Value': {'string': value, 'attachmentsByRange': attachments},
            'WFSerializationType': 'WFTextTokenString'}

def if_start(value, condition, operand=None):
    group = uid()
    params = dict(GroupingIdentifier=group, WFControlFlowMode=0,
                  WFCondition=condition, WFInput={'Type':'Variable','Variable':ref(value)})
    if operand is not None:
        params['WFNumberValue' if condition < 4 else 'WFConditionalActionString'] = operand
    add('conditional', **params)
    return group

def end(group): add('conditional', GroupingIdentifier=group, WFControlFlowMode=2)
def stop(): add('exit')
def explain_stop(message):
    group = if_start(mode, 4, 'preview')
    add('showresult', Text=message)
    end(group)
    stop()
def getkey(source, key): return add('getvalueforkey', WFInput=ref(source), WFDictionaryKey=key, WFGetDictionaryValueType='Value')
def getfile(path): return add('documentpicker.open', WFGetFilePath=path, WFShowFilePicker=False, WFFileErrorIfNotFound=True, WFFileStorageService='iCloud Drive')
def save(source, path='xiaoc-activity-upload-state.txt'):
    return add('documentpicker.save', WFInput=ref(source), WFAskWhereToSave=False,
               WFFileDestinationPath=path,
               WFSaveFileOverwrite=True, WFFileStorageService='iCloud Drive')
def calculate(left, operation, right): return add('math', WFInput=ref(left), WFMathOperation=operation, WFMathOperand=right)
def field(key, value):
    return {'WFItemType':0, 'WFKey':text(key), 'WFValue': value if isinstance(value, dict) else text(value)}
def fields(*items): return {'Value':{'WFDictionaryFieldValueItems':list(items)},'WFSerializationType':'WFDictionaryFieldValue'}

add('comment', WFCommentActionText='小C活动上传候选版：默认仅预览，不联网、不修改文件。服务端尚未部署。导入后先手动运行验证。不要删除现有快捷指令或修改六条自动化。')
mode = add('gettext', WFTextActionText='preview')
token = add('gettext', WFTextActionText='REPLACE_WITH_ACTIVITY_UPLOAD_TOKEN')
url = add('gettext', WFTextActionText='https://memory-api-beta.vercel.app/api/user-state?action=upload-device-activity')
state_file = getfile('xiaoc-activity-upload-state.txt')
state = add('detect.dictionary', WFInput=ref(state_file))
ack = getkey(state, 'acknowledged_lines')
last = getkey(state, 'last_attempt_at')
previous = add('detect.date', WFInput=ref(last))
now = add('date', WFDateActionMode='Current Date')
elapsed = add('gettimebetweendates', WFTimeUntilFromDate=text(ref(previous)), WFInput=text(ref(now)), WFTimeUntilUnit='Seconds')
g = if_start(elapsed, 0, 300)
explain_stop('预览：距离上次上传尝试不足五分钟，本次结束。没有联网或修改文件。')
end(g)
logfile = getfile('xiaoc-activity.txt')
logtext = add('detect.text', WFInput=ref(logfile))
lines = add('text.split', text=ref(logtext), WFTextSeparator='New Lines')
count = add('count', Input=ref(lines), WFInput=ref(lines), WFCountType='Items')
g = if_start(count, 1, ref(ack))
explain_stop('预览：当前没有新记录，或进度大于日志行数。本次结束，没有联网或修改文件。')
end(g)
start = calculate(ack, '+', 1)
finish = calculate(ack, '+', 300)
add('setvariable', WFVariableName='BatchEnd', WFInput=ref(finish))
g = if_start(finish, 2, ref(count))
add('setvariable', WFVariableName='BatchEnd', WFInput=ref(count)); end(g)
batch_end = {'Value':{'Type':'Variable','VariableName':'BatchEnd'},'WFSerializationType':'WFTextTokenAttachment'}
batch = add('getitemfromlist', WFInput=ref(lines), WFItemSpecifier='Items in Range', WFItemRangeStart=ref(start), WFItemRangeEnd=batch_end)
joined = add('text.combine', text=ref(batch), WFTextSeparator='New Lines')
# Do not advance over a transient terminal empty item: future appended text can fill it.
g = if_start(mode, 4, 'preview')
add('showresult', Text=text('预览模式：不会上传，也不会改进度。\n\n', ref(joined)))
stop(); end(g)
nonempty = add('text.match', text=text(ref(joined)), WFMatchTextPattern=r'(?m)^\s*\d{4}-\d{2}-\d{2} .*\S\s*$', WFMatchTextCaseSensitive=True)
g = if_start(nonempty, 101); stop(); end(g)
g = if_start(token, 4, 'REPLACE_WITH_ACTIVITY_UPLOAD_TOKEN')
add('showresult', Text='尚未填写专用上报凭证，未发送。'); stop(); end(g)
g = if_start(mode, 5, 'upload'); stop(); end(g)
stamp = add('format.date', WFDate=text(ref(now)), WFDateFormatStyle='Custom',
            WFDateFormat='Custom', WFDateFormatString="yyyy-MM-dd'T'HH:mm:ssXXXXX")
attempt = add('gettext', WFTextActionText=text('{"version":1,"acknowledged_lines":',ref(ack),',"last_attempt_at":"',ref(stamp),'"}'))
save(attempt)
response = add('downloadurl', WFURL=text(ref(url)), WFHTTPMethod='POST', WFHTTPBodyType='JSON',
               WFHTTPHeaders=fields(field('x-xiaoc-activity-token', text(ref(token)))),
               WFJSONValues=fields(field('log', text(ref(joined)))))
result = getkey(response, 'status')
g = if_start(result, 4, 'accepted')
# Match nonempty records within the raw range so trailing empty slots remain unacknowledged.
last_item = add('getitemfromlist', WFInput=ref(batch), WFItemSpecifier='Last Item')
add('setvariable', WFVariableName='AcknowledgedEnd', WFInput=batch_end)
h = if_start(last_item, 101)
one_less = add('math', WFInput=batch_end, WFMathOperation='-', WFMathOperand=1)
add('setvariable', WFVariableName='AcknowledgedEnd', WFInput=ref(one_less)); end(h)
ack_end={'Value':{'Type':'Variable','VariableName':'AcknowledgedEnd'},'WFSerializationType':'WFTextTokenAttachment'}
confirmed = add('gettext', WFTextActionText=text('{"version":1,"acknowledged_lines":',ack_end,',"last_attempt_at":"',ref(stamp),'"}'))
save(confirmed); end(g)

workflow = {
 'WFWorkflowName':'XiaoC-Activity-Upload-v3', 'WFWorkflowActions':actions,
 'WFWorkflowClientVersion':'3036.0.4.2', 'WFWorkflowMinimumClientVersion':900,
 'WFWorkflowMinimumClientVersionString':'900', 'WFWorkflowTypes':[],
 'WFWorkflowInputContentItemClasses':[], 'WFWorkflowOutputContentItemClasses':[],
 'WFWorkflowHasShortcutInputVariables':False, 'WFWorkflowHasOutputFallback':False,
 'WFWorkflowImportQuestions':[],
 'WFWorkflowIcon':{'WFWorkflowIconStartColor':4282601983,'WFWorkflowIconGlyphNumber':59511},
}

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    ids={a['WFWorkflowActionParameters']['UUID'] for a in actions}
    def validate(value):
        if isinstance(value,dict):
            if 'OutputUUID' in value: assert value['OutputUUID'] in ids
            for child in value.values(): validate(child)
        elif isinstance(value,list):
            for child in value: validate(child)
    validate(workflow)
    # These slots differ in native Shortcuts; wrong envelopes silently import as blank.
    for item in actions:
        identifier, params = item['WFWorkflowActionIdentifier'], item['WFWorkflowActionParameters']
        if identifier.endswith('.count'):
            assert params['Input'] == params['WFInput']
        if identifier.endswith('.documentpicker.save'):
            assert params['WFFileDestinationPath'] == 'xiaoc-activity-upload-state.txt'
            assert 'WFSaveFileDestinationPath' not in params
        for action, key in [('text.match', 'text'), ('downloadurl', 'WFURL'), ('format.date', 'WFDate')]:
            if identifier == 'is.workflow.actions.' + action:
                assert params[key]['WFSerializationType'] == 'WFTextTokenString'
    for fmt,name in [(plistlib.FMT_XML,'uploader-source.plist'),(plistlib.FMT_BINARY,'uploader-unsigned.shortcut')]:
        with (OUT/name).open('wb') as f: plistlib.dump(workflow,f,fmt=fmt)
    print(f'Generated {len(actions)} native actions; references validated; default preview mode.')
