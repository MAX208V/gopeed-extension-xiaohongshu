# Gopeed 小红书下载扩展

解析小红书笔记链接，自动下载图文原图和视频。

## 安装

1. 打开 Gopeed → 设置 → 扩展
2. 开发者模式：**连续点击安装按钮 5 次**
3. 选择本项目目录安装

或托管到 Git 仓库后，通过仓库地址安装。

## 支持的链接格式

| 类型 | URL 格式 |
|------|---------|
| 笔记页 | `https://www.xiaohongshu.com/explore/{noteId}` |
| 笔记页 | `https://www.xiaohongshu.com/discovery/item/{noteId}` |
| 分享短链 | `https://xhslink.com/{code}` |

## 使用方法

1. 复制小红书笔记链接
2. 在 Gopeed 中新建任务，粘贴链接
3. 点击下载，扩展会自动解析并下载图片/视频

## 设置项

| 设置 | 说明 |
|------|------|
| **Cookie** | 小红书登录 Cookie。从浏览器 DevTools → Network → 任意请求 → Request Headers → Cookie 获取。不填也能用，但部分内容可能受限。 |
| **User-Agent** | 自定义 UA，留空使用默认 Chrome UA。 |

## 工作原理

1. 匹配小红书 URL，提取笔记 ID
2. 请求笔记页面 HTML
3. 从 `window.__INITIAL_STATE__` 提取结构化数据
4. 图文笔记 → 提取 `imageList` 原图 URL
5. 视频笔记 → 提取最高清 H264 视频流
6. 返回文件列表给 Gopeed 下载

## 注意事项

- 需要 Gopeed ≥ 2.0.0
- 小红书有反爬机制，建议设置有效 Cookie
- 私密笔记需要对应账号的 Cookie 才能下载
- 小红书改版可能导致解析失败，届时需更新扩展
