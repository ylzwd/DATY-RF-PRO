# 第三方组件

| 组件 | 版本 | 许可证与来源 |
| --- | --- | --- |
| .NET / Windows Desktop Runtime | 10.0.12 | 随包 `licenses/DOTNET-LICENSE.txt`、`WindowsDesktop-LICENSE.txt` 及 .NET 第三方声明 |
| Jint | 4.16.2 | BSD-2-Clause；https://github.com/sebastienros/jint，固定提交 730db51d99d3bede8072ca55b0437c3206b83599 |
| Acornima | 1.7.0 | BSD-3-Clause；https://github.com/adams85/acornima，固定提交 401bd62d8aeb9f7cbe7b6147937a87e0c71747a8 |
| MQTTnet | 5.2.0.1603 | MIT；https://github.com/dotnet/MQTTnet/releases/tag/v5.2.0；`licenses/MQTTnet-LICENSE.txt` |
| MQTT.js | 5.10.4 | MIT；https://github.com/mqttjs/MQTT.js/tree/v5.10.4；`licenses/MQTTjs-LICENSE.txt`，源码内原许可证同时保留 |
| RFutils（设计参考） | 9c223ae4b9240ce09895640136fff47682b2300a | MIT；https://github.com/stoatworks-labs/RFutils/tree/9c223ae4b9240ce09895640136fff47682b2300a；`licenses/RFutils-LICENSE.txt` |

DATY 自有业务源码采用项目根目录 MIT 许可证。第三方组件保持各自的版权和许可证，不能将根许可证用于覆盖第三方声明。MQTT.js 的原始许可位于 `app/FAshe/vendor/mqtt-5.10.4/LICENSE.md`；浏览器中的同源 MQTT.js 副本适用同一许可。

RFutils 是文件转换、Shure 发现与下发模块的设计参考，范围见对应源码注释；保留上游 MIT 许可及 `Copyright (c) 2026 Stoatworks Labs`。当前插件导出包在 `src/licenses/` 内携带 DATY 与 RFutils 许可证，许可证文件也纳入逐文件摘要。


当前舒尔完整离线包包含 DATY 自有插件源码、清单与摘要，不携带 Shure SystemAPI 安装器或认证材料。旧完整包的兼容识别记录不代表随本项目重新分发官方安装器；不复制已安装服务目录、SharedKey 或私钥。SystemAPI 参考来源：https://www.shure.com/en-US/products/software/systemapi 。

GitHub Release 的源码归档包含仓库中已跟踪的文件。项目内 SDK、Python/Node 运行时、构建缓存及当前完整离线插件包由单独的完整绿色包提供，并非本次源码 Release 的附件；它们的分发仍须保留各自随包许可证。
