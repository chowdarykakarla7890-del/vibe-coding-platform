import { useFixErrors } from '@/components/settings/use-settings'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

export function AutoFixErrors() {
  const [fixErrors, setFixErrors] = useFixErrors()
  return (
    <div className="-m-2 flex items-center justify-between rounded p-2 hover:bg-accent/50">
      <div className="flex-1 space-y-1">
        <Label className="cursor-pointer text-sm text-foreground" htmlFor="auto-fix">
          Automatic diagnostics
        </Label>
        <p className="text-sm leading-relaxed text-muted-foreground" id="auto-fix-description">
          Sends likely command failures to the AI tutor for diagnosis. Uses your AI quota.
        </p>
      </div>
      <Checkbox
        aria-describedby="auto-fix-description"
        id="auto-fix"
        className="ml-3"
        checked={fixErrors}
        onCheckedChange={(checked) =>
          setFixErrors(checked === 'indeterminate' ? false : checked)
        }
      />
    </div>
  )
}
