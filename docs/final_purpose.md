目标
1. 处理 omp/oh-my-pi 聊天历史 为高质量记忆，检索质量高，可用于相关内容的上下文注入
2. 适配不同 codeing agent 

技术路线
1. 统一 codeing agent 聊天历史 和 活跃session 的处理管线，尽可能复用活跃session管线
2. 使用 queue 处理大量 llm 请求，接受高 llm 用量，追求记忆质量
