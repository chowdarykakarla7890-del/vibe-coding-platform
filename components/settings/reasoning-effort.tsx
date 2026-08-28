import { Models } from "@/ai/constants";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useModelId, useReasoningEffort } from "./use-settings";

export function ReasoningEffort() {
  const [modelId] = useModelId();
  const [effort, setEffort] = useReasoningEffort();
  if (modelId !== Models.OpenAIGPT53Codex) {
    return null;
  }

  return (
    <div className="-m-2 flex items-center justify-between rounded p-2 hover:bg-accent/50">
      <div className="flex-1 space-y-1">
        <Label className="cursor-pointer text-sm text-foreground" htmlFor="effort-level">
          Higher Effort Level
        </Label>
        <p className="text-sm leading-relaxed text-muted-foreground" id="effort-level-description">
          With GPT-5.3 Codex, you can request higher reasoning effort level.
        </p>
      </div>
      <Checkbox
        aria-describedby="effort-level-description"
        id="effort-level"
        className="ml-3"
        checked={effort === "medium"}
        onCheckedChange={(checked) =>
          setEffort(checked === true ? "medium" : "low")
        }
      />
    </div>
  );
}
