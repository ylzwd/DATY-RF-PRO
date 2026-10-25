# 第三方组件

| 组件 | 版本 | 许可证与来源 |
| --- | --- | --- |
| .NET / Windows Desktop Runtime | 10.0.12 | 随包 `licenses/DOTNET-LICENSE.txt`、`WindowsDesktop-LICENSE.txt` 及 .NET 第三方声明 |
| Jint | 4.16.2 | BSD-2-Clause；https://github.com/sebastienros/jint，固定提交 730db51d99d3bede8072ca55b0437c3206b83599 |
| Acornima | 1.7.0 | BSD-3-Clause；https://github.com/adams85/acornima，固定提交 401bd62d8aeb9f7cbe7b6147937a87e0c71747a8 |

原服务器 frequency.js、scan-csv.js、equipment-profiles.js、coordination.js、rf-simulation.js、DATY Logo 和公开 CA 来自用户本项目，未从研读目录合并 GPL 或其他第三方业务实现。依赖许可证原文位于 `licenses/`。发布包不包含私钥、访问密钥、数据库、接收机配对或用户业务数据。

MQTTnet 5.2.0.1603（MIT）：https://github.com/dotnet/MQTTnet/releases/tag/v5.2.0 ；https://www.nuget.org/packages/MQTTnet/5.2.0.1603 。固定NuGet锁文件内容摘要，许可证位于licenses/MQTTnet-LICENSE.txt。


当前舒尔完整离线包包含 DATY 自有插件源码、清单与摘要，不携带 Shure SystemAPI 安装器或认证材料。旧完整包的兼容识别记录不代表随本项目重新分发官方安装器；不复制已安装服务目录、SharedKey 或私钥。SystemAPI 参考来源：https://www.shure.com/en-US/products/software/systemapi 。
