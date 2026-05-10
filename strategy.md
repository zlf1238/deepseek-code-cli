你的观察很准确：当前 `selectModelForIteration` 的逻辑确实过于简化——仅依靠 `hadToolCalls` 一个布尔值来决定是否从 `deepseek-v4-pro` 切换到 `deepseek-v4-flash`。这种策略忽略了任务复杂度、上下文预算、用户意图等多维因素，在追求“编程能力强、token消耗小、花费便宜”的目标下，仍有很大的优化空间。



以下从\*\*五个维度\*\*给出优化方向，并提供具体可落地的实现方案。



\---



\## 一、当前策略的不足



```typescript

// model-capabilities.ts

export function selectModelForIteration(primaryModel: string, hadToolCalls: boolean): string {

&#x20; if (primaryModel !== DEEPSEEK\_V4\_PRO || !hadToolCalls) return primaryModel;

&#x20; return DEEPSEEK\_V4\_FLASH;

}

```



问题：

1\. \*\*任何工具调用后都切 flash\*\* —— 但像 `AskUserQuestion` 或简单 `grep` 后，用户可能期望继续用 pro 进行深度分析。

2\. \*\*不考虑工具调用类型\*\* —— 修改 10 个文件 与 读取一个文件 都同等对待。

3\. \*\*无回退机制\*\* —— flash 能力不足时无法自动升级到 pro。

4\. \*\*忽略 token 预算\*\* —— 上下文接近上限时，用 flash 快速收尾更省钱；反之预算充足时用 pro 可获得更优方案。

5\. \*\*无视用户显式/隐式偏好\*\* —— 用户反复纠正时应该降级（或升级）模型。



\---



\## 二、优化方向总览



| 方向 | 目标 | 实现难度 | 预估收益 |

|------|------|----------|----------|

| 1. 任务复杂度评估 | 复杂任务用 pro，简单任务用 flash | 中 | 高 |

| 2. 工具调用类型分类 | 避免对咨询类工具错误切换 | 低 | 中 |

| 3. Token 预算感知 | 扩容时用 pro，紧张时用 flash | 低 | 中 |

| 4. 失败回退与重试 | flash 效果差时自动升级到 pro | 中 | 高 |

| 5. 用户反馈学习 | 记录纠正次数，动态调整切换阈值 | 高 | 中 |



\---



\## 三、具体优化方案（推荐顺序实现）



\### 🎯 优化 1：基于任务复杂度的分级切换（性价比最高）



\*\*核心思想\*\*：将任务分为三个复杂度等级，不同等级使用不同模型策略。



```typescript

// model-capabilities.ts 新增



type TaskComplexity = 'simple' | 'medium' | 'complex';



function estimateTaskComplexity(

&#x20; userPrompt: string,

&#x20; lastToolCalls?: unknown\[]

): TaskComplexity {

&#x20; // 1. 用户消息长度启发

&#x20; if (userPrompt.length > 2000) return 'complex';

&#x20; if (userPrompt.length < 200) return 'simple';

&#x20; 

&#x20; // 2. 关键词检测

&#x20; const complexKeywords = \['重构', '架构', '设计', '多文件', '性能优化', '安全', '测试'];

&#x20; const simpleKeywords = \['读', '找', '搜索', '执行', '运行', '安装'];

&#x20; 

&#x20; if (complexKeywords.some(kw => userPrompt.includes(kw))) return 'complex';

&#x20; if (simpleKeywords.some(kw => userPrompt.includes(kw))) return 'simple';

&#x20; 

&#x20; // 3. 上一次工具调用类型

&#x20; if (lastToolCalls?.length) {

&#x20;   const lastToolName = getToolName(lastToolCalls\[0]);

&#x20;   if (lastToolName === 'edit' || lastToolName === 'write') return 'complex';

&#x20;   if (lastToolName === 'AskUserQuestion') return 'simple';

&#x20; }

&#x20; 

&#x20; return 'medium';

}



export function selectModelForIterationAdvanced(

&#x20; primaryModel: string,

&#x20; hadToolCalls: boolean,

&#x20; context: {

&#x20;   userPrompt?: string;

&#x20;   lastToolCalls?: unknown\[];

&#x20;   currentTokenUsage?: number;

&#x20;   tokenLimit?: number;

&#x20; }

): string {

&#x20; // 基础 fallback

&#x20; if (primaryModel !== DEEPSEEK\_V4\_PRO) return primaryModel;

&#x20; 

&#x20; // 未发生工具调用：首次回答，根据复杂度决定

&#x20; if (!hadToolCalls) {

&#x20;   const complexity = estimateTaskComplexity(context.userPrompt || '');

&#x20;   if (complexity === 'complex') return DEEPSEEK\_V4\_PRO;

&#x20;   if (complexity === 'simple') return DEEPSEEK\_V4\_FLASH;

&#x20;   return primaryModel; // medium 用 pro

&#x20; }

&#x20; 

&#x20; // 已有工具调用：检查复杂度 \& token 预算

&#x20; const complexity = estimateTaskComplexity('', context.lastToolCalls);

&#x20; const tokenPressure = (context.currentTokenUsage || 0) / (context.tokenLimit || 1);

&#x20; 

&#x20; // 预算紧张 (>80%) 且任务不复杂 → 用 flash 快速收尾

&#x20; if (tokenPressure > 0.8 \&\& complexity !== 'complex') {

&#x20;   return DEEPSEEK\_V4\_FLASH;

&#x20; }

&#x20; 

&#x20; // 复杂任务即使有工具调用也继续用 pro（避免质量下降）

&#x20; if (complexity === 'complex') {

&#x20;   return DEEPSEEK\_V4\_PRO;

&#x20; }

&#x20; 

&#x20; // 默认用 flash（省钱）

&#x20; return DEEPSEEK\_V4\_FLASH;

}

```



\### 🎯 优化 2：工具调用类型白名单 + 黑名单



某些工具调用不应该触发模型降级。



```typescript

// model-capabilities.ts



const NO\_SWITCH\_TOOLS = new Set(\[

&#x20; 'AskUserQuestion',   // 用户交互后需要继续深度思考

&#x20; 'WebSearch',         // 搜索结果可能需要复杂分析

]);



const ALWAYS\_SWITCH\_TOOLS = new Set(\[

&#x20; 'bash',              // 执行命令后通常只需确认结果

&#x20; 'glob', 'grep',      // 纯搜索，flash 足够

]);



function shouldSwitchAfterToolCalls(toolCalls: unknown\[]): boolean {

&#x20; for (const tc of toolCalls) {

&#x20;   const name = getToolName(tc);

&#x20;   if (NO\_SWITCH\_TOOLS.has(name)) return false;

&#x20;   if (ALWAYS\_SWITCH\_TOOLS.has(name)) return true;

&#x20; }

&#x20; // 默认：有 edit/write 等复杂操作时暂不切换，等下一轮再评估

&#x20; return false;

}

```



\### 🎯 优化 3：Token 预算感知的渐进式降级



当上下文即将爆满时，强制使用 flash 来生成紧凑回复。



```typescript

// session.ts 中的 activateSession 循环内



const currentTokens = session.activeTokens;

const tokenLimit = getContextWindowCapacity(currentModel);

const usageRatio = currentTokens / tokenLimit;



let nextModel = primaryModel;

if (usageRatio > 0.85) {

&#x20; // 接近上限：强制 flash 并注入紧凑指令

&#x20; nextModel = DEEPSEEK\_V4\_FLASH;

&#x20; // 可以额外添加系统消息： "上下文即将用尽，请给出极简答案"

} else if (usageRatio > 0.7 \&\& hadToolCalls) {

&#x20; // 中等压力 + 有工具调用 → 倾向用 flash

&#x20; nextModel = DEEPSEEK\_V4\_FLASH;

} else {

&#x20; // 正常情况走原有逻辑

&#x20; nextModel = selectModelForIterationAdvanced(...);

}

```



\### 🎯 优化 4：失败回退机制



当 flash 生成的回复质量明显低时（例如拒绝回答、输出为空、工具调用失败），自动回退到 pro 重试。



```typescript

// session.ts 中处理响应后



if (currentModel === DEEPSEEK\_V4\_FLASH \&\& 

&#x20;   (refusal || !content || content.includes("I cannot assist"))) {

&#x20; // 标记需要重试

&#x20; const retryModel = DEEPSEEK\_V4\_PRO;

&#x20; const retryClient = createOpenAIClient(retryModel);

&#x20; if (retryClient.client) {

&#x20;   // 重新发起请求，使用相同消息

&#x20;   const retryResponse = await createChatCompletionStream(...);

&#x20;   // 替换原有响应

&#x20; }

}

```



\### 🎯 优化 5：用户反馈统计（长期学习）



记录每个会话中用户打断/纠正的次数，动态调整该项目的切换倾向。



```typescript

// settings.json 增加

{

&#x20; "autoSwitch": {

&#x20;   "enabled": true,

&#x20;   "aggressiveness": 0.5,  // 0=从不切换, 1=激进切换

&#x20;   "userCorrectionCount": 0

&#x20; }

}

```



每次用户按下 `esc` 打断或输入“不，你应该...”时，计数+1，超过阈值后自动提高 `aggressiveness`（更倾向用 pro）。



\---



\## 四、推荐的最简实现（立即见效）



如果暂时不想引入复杂逻辑，可以改进现有函数为：



```typescript

export function selectModelForIteration(

&#x20; primaryModel: string,

&#x20; hadToolCalls: boolean,

&#x20; lastToolName?: string

): string {

&#x20; if (primaryModel !== DEEPSEEK\_V4\_PRO) return primaryModel;

&#x20; if (!hadToolCalls) return primaryModel;



&#x20; // 仅在非交互式、非搜索类工具调用后切换

&#x20; const stayProTools = \['AskUserQuestion', 'WebSearch'];

&#x20; if (lastToolName \&\& stayProTools.includes(lastToolName)) {

&#x20;   return DEEPSEEK\_V4\_PRO;

&#x20; }



&#x20; // 其他情况用 flash

&#x20; return DEEPSEEK\_V4\_FLASH;

}

```



然后再配合 \*\*优化 3（Token 预算感知）\*\* 和 \*\*优化 4（失败回退）\*\*，即可在不大幅改动架构的前提下，显著提升能力/成本平衡。



\---



\## 五、总结



| 优先级 | 优化项 | 效果 |

|--------|--------|------|

| P0 | 任务复杂度分级 + token 预算感知 | 立即提升决策质量，防止过度降级 |

| P1 | 工具调用类型分类 | 避免 AskUserQuestion 后错误切换 |

| P2 | 失败回退机制 | 保证最终答案质量，用户体验不受损 |

| P3 | 用户反馈统计 | 长期自适应的理想方向 |



\*\*最终目标\*\*：在 90% 的常规任务中使用便宜的 flash，在 10% 的高复杂度或关键决策点自动使用强大的 pro，整体 token 消耗下降 40%\~60%，而编程能力几乎不损失。

