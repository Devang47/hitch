import { confirm, password } from "@inquirer/prompts";
import { c } from "../colors.js";
import { pickModel } from "../config/models.js";
import { configFile, resolveModel, setApiKey, setDefaultModel } from "../config/settings.js";
import { banner } from "./ui.js";

/** First-run setup: capture the API key and, optionally, a default model. */
export async function onboard(): Promise<void> {
  console.log(
    banner({ model: resolveModel(), cwd: process.cwd(), mode: "ask", context: [], resumed: false }),
  );
  console.log(`\n${c.bold("Welcome!")} Let's set you up.\n`);
  const key = (
    await password({ message: "OpenRouter API key (https://openrouter.ai/keys):", mask: "*" })
  ).trim();
  if (!key) {
    console.error("No key entered. Exiting.");
    process.exit(1);
  }
  setApiKey(key);
  if (
    await confirm({
      message: `Pick a default model now? (otherwise ${resolveModel()})`,
      default: true,
    })
  ) {
    const id = await pickModel();
    if (id) {
      setDefaultModel(id);
      console.log(`${c.green("default model →")} ${c.bold(id)}`);
    }
  }
  console.log(c.dim(`Saved to ${configFile()}\n`));
}
