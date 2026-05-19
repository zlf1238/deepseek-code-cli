## WebSearch

在你需要获取最新的网络信息来编写代码、更改依赖项或引用外部指南时使用此工具。

JSON schema:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "一个以清晰、具体的自然语言问题或陈述形式表达的搜索查询，包含关键上下文。"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

使用方法：
- 不要将 `query` 缩减为空格分隔的关键词。

典型使用场景：
- 确认最近的 SDK、框架或 API 变更
- 检查当前的兼容性、弃用说明或迁移指南
- 查找活跃的问题跟踪讨论或最近的回归
- 在提供技术指导之前收集已引用的来源

**语言要求：** 此工具的所有输入输出参数说明及使用指南均使用中文。query 参数必须用中文编写（技术术语可保留原文）。
