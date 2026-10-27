"""Generate an isolated native Shortcuts state-file smoke test, without HTTP actions."""
from pathlib import Path
import plistlib
import runpy

base = runpy.run_path(str(Path(__file__).with_name('build-device-activity-shortcut.py')))
actions = base['actions']
actions.clear()
add, ref, text = (base[k] for k in ('add', 'ref', 'text'))
if_start, end, stop, getkey, getfile = (base[k] for k in ('if_start', 'end', 'stop', 'getkey', 'getfile'))
test_path = 'xiaoc-upload-selftest-state.txt'

def save(value):
    return base['save'](value, test_path)

def verify_cursor(expected, stage):
    file_id = getfile(test_path)
    dictionary = add('detect.dictionary', WFInput=ref(file_id))
    cursor = getkey(dictionary, 'acknowledged_lines')
    # Normalize number to Text for a native string equality comparison.
    cursor_text = add('gettext', WFTextActionText=text(ref(cursor)))
    group = if_start(cursor_text, 5, str(expected))
    add('showresult', Text='FAIL：' + stage + '。只修改了独立测试文件，真实上传状态未改。')
    stop()
    end(group)
    return dictionary

add('comment', WFCommentActionText='离线状态保存测试：只覆盖 Shortcuts/xiaoc-upload-selftest-state.txt；不读取或修改真实活动日志/上传状态，不联网、不调用模型。模拟失败与成功，不证明 HTTP、并发、断电恢复或真实上传通过。')
now = add('date', WFDateActionMode='Current Date')
stamp = add('format.date', WFDate=text(ref(now)), WFDateFormatStyle='Custom',
            WFDateFormat='Custom', WFDateFormatString="yyyy-MM-dd'T'HH:mm:ssXXXXX")
initial = add('gettext', WFTextActionText='{"version":1,"acknowledged_lines":0,"last_attempt_at":"2000-01-01T00:00:00+08:00"}')
save(initial)
verify_cursor(0, '初始化读取')

# This is the same save-before-network shape used by the uploader.
attempt = add('gettext', WFTextActionText=text('{"version":1,"acknowledged_lines":0,"last_attempt_at":"', ref(stamp), '"}'))
save(attempt)
dictionary = verify_cursor(0, '模拟尝试/失败后进度必须仍为0')
saved_stamp = getkey(dictionary, 'last_attempt_at')
saved_text = add('gettext', WFTextActionText=text(ref(saved_stamp)))
group = if_start(saved_text, 5, text(ref(stamp)))
add('showresult', Text='FAIL：时间写入后读回不一致。真实上传状态未改。')
stop(); end(group)

# Simulated acceptance of two records; no network response is fabricated as real.
accepted = add('gettext', WFTextActionText=text('{"version":1,"acknowledged_lines":2,"last_attempt_at":"', ref(stamp), '"}'))
save(accepted)
verify_cursor(2, '模拟确认成功后进度必须为2')
add('showresult', Text='PASS：离线状态文件写入/读回通过。\n\n初始化进度：0\n模拟尝试或失败后：仍为0\n时间写入读回：一致\n模拟确认成功后：2\n\n没有联网，真实活动记录与上传进度未修改。此结果不代表实际上传、并发或五分钟门槛已通过。')

workflow = {**base['workflow'], 'WFWorkflowName':'XiaoC-Upload-State-Test-v2', 'WFWorkflowActions':actions}
out = base['OUT']
out.mkdir(parents=True, exist_ok=True)
assert not any(a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.downloadurl' for a in actions)
for a in actions:
    p=a['WFWorkflowActionParameters']
    if a['WFWorkflowActionIdentifier'].endswith('.documentpicker.open'):
        assert p['WFGetFilePath'] == test_path
    if a['WFWorkflowActionIdentifier'].endswith('.documentpicker.save'):
        assert p['WFFileDestinationPath'] == test_path
        assert 'WFSaveFileDestinationPath' not in p
for fmt, name in [(plistlib.FMT_XML, 'state-test-source.plist'), (plistlib.FMT_BINARY, 'state-test-unsigned.shortcut')]:
    with (out/name).open('wb') as f:
        plistlib.dump(workflow, f, fmt=fmt)
print(f'Generated isolated state test: {len(actions)} actions; only {test_path}; no HTTP.')
