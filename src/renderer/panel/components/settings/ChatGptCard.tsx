import { useState } from 'react';
import { clicky } from '../../clicky';
import { SettingsCard } from './SettingsCard';
import { STATUS_TINT } from '../status-tint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { PatchSettings } from './patch';
import type { Settings } from '../../../../shared/types';

interface ChatGptCardProps {
  settings: Settings;
  onPatch: PatchSettings;
}

/**
 * ChatGPT-subscription sign-in card. Existing Codex CLI auth is detected,
 * and users without it can connect through the system-browser PKCE flow.
 */
export function ChatGptCard({ settings, onPatch }: ChatGptCardProps): React.JSX.Element {
  const [signingIn, setSigningIn] = useState(false);
  const [signInMessage, setSignInMessage] = useState<string | null>(null);

  const signIn = async (): Promise<void> => {
    if (signingIn) return;
    setSigningIn(true);
    const result = await clicky.signInToCodex();
    setSignInMessage(result.ok ? 'finish signing in in your browser' : result.error);
    setSigningIn(false);
  };

  return (
    <SettingsCard title="chatgpt">
      {settings.codexSignedIn ? (
        <>
          <div className="flex min-h-7 items-center gap-2">
            {settings.codexValid ? (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.positive)}
              >
                signed in to ChatGPT
                {settings.codexPlanType ? ` (${settings.codexPlanType})` : ''}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.warning)}
              >
                chatgpt session expired — reconnect below
              </Badge>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            buddy uses your chatgpt plan for pointing and helper buddies. voice still needs an
            openai api key.
          </p>
          <div className="flex min-h-7 items-center gap-2.5 pt-2.5">
            <Label
              htmlFor="prefer-api-grounding"
              className="flex-1 text-xs font-normal text-muted-foreground"
            >
              use api key for pointing
            </Label>
            <Switch
              id="prefer-api-grounding"
              checked={settings.preferApiKeyGrounding}
              onCheckedChange={(checked) => void onPatch({ preferApiKeyGrounding: checked })}
            />
          </div>
          <div className="flex min-h-7 items-center gap-2.5 pt-2.5">
            <div className="flex flex-1 flex-col gap-0.5">
              <Label htmlFor="computer-use" className="text-xs font-normal text-muted-foreground">
                let sol click &amp; type
              </Label>
              <span className="text-[10px] leading-relaxed text-muted-foreground/70">
                realtime can only delegate; sol chooses every action in chatgpt fast mode.
              </span>
            </div>
            <Switch
              id="computer-use"
              checked={settings.computerUseEnabled}
              disabled={!settings.codexValid}
              onCheckedChange={(checked) => void onPatch({ computerUseEnabled: checked })}
            />
          </div>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          connect chatgpt to use your plan for pointing and helper buddies.
        </p>
      )}
      {!settings.codexValid ? (
        <Button
          type="button"
          size="sm"
          className="self-start rounded-full"
          disabled={signingIn}
          onClick={() => void signIn()}
        >
          {signingIn ? 'opening browser…' : 'connect chatgpt'}
        </Button>
      ) : null}
      {signInMessage ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">{signInMessage}</p>
      ) : null}
    </SettingsCard>
  );
}
