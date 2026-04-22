👑 GripLite (轻量级数据库管理 IDE) 核心 PRD
一、 产品愿景与架构约束
定位： 对标 DataGrip 的核心查询与管理体验，但常驻内存控制在 200MB 以内。

架构： 前端 React + Wails IPC + 后端 Go。

核心原则： * 宁可少一个功能，也不能让 UI 卡顿。

所有耗时 I/O（查询、连接、元数据加载）必须可取消（Context Cancellation）。

二、 核心功能模块划分 (Epics)
模块 A：连接与会话管理 (Connection & Session)
A1 数据源配置： 支持配置 MySQL/MongoDB 连接信息（Host, Port, User, Password, SSH Tunnel）。

A2 凭证安全： 密码不可明文存储，需调用系统级 Keychain 或加密存储在本地 SQLite。

A3 连接池管理： 每个数据源在 Go 后端维护独立的连接池，支持心跳保活和自动重连。

模块 B：数据库导航树 (Database Explorer)
B1 树形渲染： 支持多级展开：Data Source -> Database -> Schema -> Table/View/Routine -> Column/Index。

B2 懒加载 (Lazy Load)： 绝对禁止一次性拉取全库结构，仅在用户点击展开时通过 Wails 向后端请求子节点元数据。

B3 元数据缓存： 拉取到的结构异步写入本地 SQLite，用于断网查看和智能提示。

模块 C：SQL 编辑器 (SQL Editor)
C1 多 Tab 管理： 支持同时打开多个 Console，每个 Console 绑定特定的数据库 Session。

C2 智能补全 (IntelliSense)： （核心难点）基于光标位置、AST 语法树和本地 SQLite 元数据，提供表名、字段名、JOIN 条件的精准补全。

C3 语法高亮与错误校验： 实时划红线提示 SQL 语法错误。

模块 D：数据网格与结果集 (Data Grid)
D1 虚拟 Canvas 渲染： 基于 @glideapps/glide-data-grid，支持百万级纯前端流畅滚动。

D2 分页与流式加载： 滚动到底部自动触发 LIMIT/OFFSET 后台请求。

D3 内联编辑 (Inline Editing)： 双击单元格修改数据，高亮变更状态，点击“Submit”生成 UPDATE 语句并执行。

模块 E：实用工具 (Utilities)
E1 DDL 查看器： 右键表名，生成并展示 CREATE TABLE 语句。

E2 数据导出： 支持将查询结果集直接由 Go 后端流式写入 CSV/JSON 文件，不经过前端内存。