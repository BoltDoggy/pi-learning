// 第 01 课代码实战：跑通环境 + faux provider
// 运行：cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json ../docs/course/examples/lesson-01/hello-faux.ts
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

faux.setResponses([fauxAssistantMessage("你好，我是 faux 模型。")]);

const model = faux.getModel();
const context = {
	systemPrompt: "你是一个友好的助手。",
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }] as any,
};

const stream = models.stream(model, context);
for await (const event of stream) {
	console.log(event.type, event.type === "done" ? event.message.content : "");
}

console.log("callCount =", faux.state.callCount);
