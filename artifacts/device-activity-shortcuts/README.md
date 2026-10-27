# 小C活动上传：签名导入候选

## 当前真机证据与下一项测试

用户运行首版离线测试时，在首次写入后读取 `xiaoc-upload-selftest-state.txt` 报不存在。确认保存动作的参数应为 `WFFileDestinationPath`，生成器此前误用 `WFSaveFileDestinationPath`。已统一保存函数并修复两份文件：测试使用 `XiaoC-Upload-State-Test-v2.shortcut`，上传候选使用 `XiaoC-Activity-Upload-v3.shortcut`，均重新生成并签名。上传v2仅有读取/预览通过的证据，不能用于正式上传。修复后的状态写入仍需真机复验；新增参数名断言防止再次生成错误键。

用户已在 iPhone 运行 v2 并发回含活动日志的预览截图，确认文件读取和本批预览路径通过。这不验证实际上传、状态保存或并发。下面保留的“待真机”描述是当时交付边界，以本节最新证据为准。

`XiaoC-Upload-State-Test.shortcut` 是另一个独立、已签名的离线状态文件测试，由 `scripts/build-device-activity-selftest.py` 生成。只覆盖 `Shortcuts/xiaoc-upload-selftest-state.txt`，不读取真实活动或上传状态，不含网络动作。检查初始化游标0、模拟尝试/失败后仍为0、时间读回一致、模拟接受后变为2。正常返回 PASS，失败返回具体阶段或系统文件错误。尚待用户真机运行；它只验证状态保存动作，不证明网络失败处理或并发可靠性。无需修改任何现有自动化。

## v2 — 修复用户截图确认的空输入

请使用 `XiaoC-Activity-Upload-v2.shortcut`。旧版虽然能导入，但真机截图显示 Count 的 Input、Match Text 的 text、URL 的 WFURL 和 Format Date 的 WFDate 没有正确显示为已连接输入，因此旧版不应启用上传。v2 修正参数名/变量封装，并为预览下的时间门槛和无新记录退出增加说明弹窗；完整预览提前到仅上传分支使用的正则检查之前。生成器增加这些参数封装的回归断言，plist 与变量引用检查及系统签名已通过。v2 仍待 iPhone 实际运行；不能将这些静态检查描述为真机通过。

`XiaoC-Activity-Upload.shortcut` 是系统 `shortcuts sign --mode people-who-know-me` 签名成功的候选文件。默认 `preview`，不会发请求或修改上传状态。它不包含私人记录或凭证。`anyone` 模式最小样例签名曾失败，当前采用另一种系统支持的签名方式；接收设备仍可能要求满足签名联系人/账号条件。

用 AirDrop 或文件传到 iPhone，用快捷指令打开并添加。先保留已有手动版本和六条自动化，手动运行候选版即可。固定读取当前用户验证过的 `Shortcuts/xiaoc-activity.txt` 与 `Shortcuts/xiaoc-activity-upload-state.txt`。如果设备的默认 Shortcuts 位置不同，需要重新绑定文件夹。

本次已检查 plist 语法、动作输出引用，并验证系统签名产物存在且非空。**未完成 UI 导入和 iPhone 真机运行验证**，签名成功不代表文件参数、日期序列化或动作执行都已通过。不应把候选接入自动化或改成 upload，直到预览、时间门槛、状态保存、异常退出和并发行为实测完成。

原始生成器：`scripts/build-device-activity-shortcut.py`。source plist 可审阅，unsigned 文件不是交付给手机的签名版。候选包含五分钟检查、最多300行批次、状态写入、专用 header 请求和 accepted 后推进游标。预览的初始时间门槛仍生效。终端空行不应被提前确认；并发读写尚未解决，不能宣称无丢失或严格本地单次执行。

后端未部署、凭证未设置。只有后续明确授权后再接通。没有 push、部署、改变用户既有自动化或执行生产操作。
