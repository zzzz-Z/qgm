# @qgm/client

唯一一份 SPA 构建产物，被两个宿主托管。

## 边界

- 不得 import core
- 只通过 HTTP / WS 与 core 通信
- base 路径由构建时变量注入（VITE_API_BASE）；运行时不做宿主判断
