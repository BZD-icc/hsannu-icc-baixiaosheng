# HSANNU ICC 百晓生

为东北师范大学附属中学国际课程中心学生整理的资料库。可以看 IB DP 和 IGCSE 课程轮、查资料，并按科目和老师记录选课体验，也可以和配对同学交换选中的资料。

## 使用

[打开百晓生网页](https://a15844188888-spec.github.io/hsannu-icc-baixiaosheng/) · [下载完整包或通用知识包](https://github.com/a15844188888-spec/hsannu-icc-baixiaosheng/releases/tag/v0.1.0)

- **网页**可浏览课程和公开资料。要使用网页里的 AI 问答，可以请常用的 Agent 协助配置自己已有、允许网页调用的模型服务。
- **其他 AI**可以读取[公开知识正文](web/knowledge/公开知识正文.md)和[通用提问模板](web/knowledge/提问模板.md)。
- **Codex**可以选用[百晓生 Skill](skill/hsannu-icc-baixiaosheng/)。

本机试用时，在仓库目录运行以下命令，再打开[本机网页](http://127.0.0.1:8787/)。

```sh
python3 -m http.server 8787 --bind 127.0.0.1 --directory web
```

## 资料与评价

课程轮、选课评价的教师选项和指导信息由同学提供。公开资料注明来源和适用范围，校内安排以当届学校通知为准。仓库附有虚构的选课评价样例。学生添加的记录保存在自己的浏览器，主动选择后可以导出或发送给配对同学。

[完整使用说明](使用说明.md) · [公开来源索引](web/knowledge/来源索引.md)
