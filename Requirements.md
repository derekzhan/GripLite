👑 GripLite (轻量级数据库管理 IDE) 核心 PRD
一、 产品愿景与架构约束
定位： 对标 DataGrip 的核心查询与管理体验，当前支持 MySQL 与 MongoDB，但常驻内存控制在 200MB 以内。

架构： 前端 React + Wails IPC + 后端 Go。

核心原则： * 宁可少一个功能，也不能让 UI 卡顿。

所有耗时 I/O（查询、连接、元数据加载）必须可取消（Context Cancellation）。

二、 核心功能模块划分 (Epics)
模块 A：连接与会话管理 (Connection & Session)
A1 数据源配置： 支持配置 MySQL/MongoDB 连接信息（Host, Port, User, Password, SSH Tunnel）。MongoDB 需要支持普通 Host/Port 连接与 Atlas `mongodb+srv://` SRV 连接。

A2 凭证安全： 密码不可明文存储，需调用系统级 Keychain 或加密存储在本地 SQLite。

A3 连接池管理： 每个数据源在 Go 后端维护独立的连接池，支持心跳保活和自动重连。

模块 B：数据库导航树 (Database Explorer)
B1 树形渲染： 支持多级展开：Data Source -> Database -> Schema -> Table/View/Routine -> Column/Index；MongoDB 展示为 Data Source -> Database -> Collection。

B2 懒加载 (Lazy Load)： 绝对禁止一次性拉取全库结构，仅在用户点击展开时通过 Wails 向后端请求子节点元数据。

B3 元数据缓存： 拉取到的结构异步写入本地 SQLite，用于断网查看和智能提示。

模块 C：查询编辑器 (SQL / Mongo Console)
C1 多 Tab 管理： 支持同时打开多个 Console，每个 Console 绑定特定的数据库 Session。MySQL Console 执行 SQL；MongoDB Console 执行 Mongo Shell / DataGrip Playground 风格表达式，也支持 raw JSON / Extended JSON command document。

C2 智能补全 (IntelliSense)： （核心难点）MySQL 基于光标位置、AST 语法树和本地 SQLite 元数据，提供表名、字段名、JOIN 条件的精准补全；MongoDB 在集合数据视图的 `find` / `sort` 输入框中提供字段名提示。

C3 语法高亮与错误校验： 实时划红线提示 SQL 语法错误。

模块 D：数据网格与结果集 (Data Grid)
D1 虚拟 Canvas 渲染： 基于 @glideapps/glide-data-grid，支持百万级纯前端流畅滚动。

D2 分页与流式加载： MySQL 滚动到底部自动触发 LIMIT/OFFSET 后台请求；MongoDB 集合视图使用 `find(...).skip(...).limit(...)` 加载更多文档。

D3 内联编辑 (Inline Editing)： 双击单元格修改数据，高亮变更状态。MySQL 点击“Submit”生成 UPDATE/INSERT/DELETE 并执行；MongoDB 使用 `_id` 定位文档并执行 collection update/insert/delete。

D4 MongoDB 集合视图： 双击 Collection 默认以 Grid 打开，支持 `Grid / Record / Text` 三种模式。Record 模式默认显示原始值，JSON 值可点击三角展开为可视化结构。Columns 弹层支持列名搜索、只显示非空列、全选和反选。

模块 E：实用工具 (Utilities)
E1 DDL 查看器： 右键表名，生成并展示 CREATE TABLE 语句。

E2 数据导出： 支持将查询结果集导出为 CSV/JSON。当前前端结果集导出面向已加载数据，后续大数据量导出应由 Go 后端流式写入文件，不经过前端内存。