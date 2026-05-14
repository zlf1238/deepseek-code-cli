## handle_read

按之前 Read 工具返回的 snippet_id 读取文件的特定行范围。
文件未被修改时直接从内存缓存切片（零 I/O），文件被修改时自动从磁盘回源。
跨 Turn 有效 —— 后续轮次无需重新 Read 全文件即可获取精确区域。

使用场景：
- Read 返回的大文件被截断了，需要读取中间的行
- 跨 Turn 需要查看之前读过文件的特定区域，无需重新 Read 整文件
- 在 Edit 前精确查看某个范围
- 浏览之前只看过首尾的大文件中间部分

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "snippet_id": {
      "description": "由 Read 工具在 metadata.snippet.id 中返回的 snippet id",
      "type": "string"
    },
    "lines": {
      "description": "行范围，格式 START-END（如 100-200）或 START-（如 100- 默认 200 行）",
      "type": "string"
    }
  },
  "required": ["snippet_id", "lines"],
  "additionalProperties": false
}
```
