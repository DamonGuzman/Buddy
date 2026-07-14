import { useEffect, useState } from 'react';
import { clicky } from '../clicky';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { MicDevice, ModelId, Settings } from '../../../shared/types';

const VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;

const MODELS: { id: ModelId; label: string }[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini (faster, cheaper)' },
  { id: 'gpt-realtime-2.1', label: 'gpt-realtime-2.1 (default — best pointing)' },
];

interface SettingsViewProps {
  settings: Settings;
  micDevices: MicDevice[];
  micError: string | null;
}

/** Settings: API key, model, voice, captions, mic, hotkey, agent-mode teaser. */
export function SettingsView({
  settings,
  micDevices,
  micError,
}: SettingsViewProps): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInMessage, setSignInMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);

  const saveKey = async (): Promise<void> => {
    const value = keyDraft.trim();
    if (!value || savingKey) return;
    setSavingKey(true);
    try {
      await clicky.setSettings({ apiKey: value });
      setKeyDraft('');
      setJustSaved(true);
    } finally {
      setSavingKey(false);
    }
  };

  const patch = (p: Parameters<typeof clicky.setSettings>[0]): void => {
    void clicky.setSettings(p);
  };

  const signIn = async (): Promise<void> => {
    if (signingIn) return;
    setSigningIn(true);
    const result = await clicky.signInToCodex();
    setSignInMessage(result.ok ? 'finish signing in in your browser' : result.error);
    setSigningIn(false);
  };

  return (
    <ScrollArea className="min-h-0 flex-1" data-settings-scroll>
      <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
        <Card className="gap-3 rounded-lg py-3.5 shadow-none">
          <CardHeader className="px-3.5">
            <CardTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              openai
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 px-3.5">
            <div className="flex min-h-7 items-center gap-2">
              {settings.apiKeyPresent ? (
                <>
                  {/* M11 UI (deferred by the error-catalog agent, built at M16):
                      a stored safeStorage blob that can no longer decrypt reads as
                      present-but-dead. Warn instead of the green "saved" badge
                      so the user knows to paste the key again. */}
                  {settings.apiKeyUnreadable ? (
                    <Badge
                      variant="outline"
                      className="rounded-full border-destructive/40 bg-destructive/10 font-medium text-destructive"
                    >
                      saved key unreadable — paste it again
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="rounded-full border-emerald-400/40 bg-emerald-400/10 font-medium text-emerald-300"
                    >
                      key saved ✓
                    </Badge>
                  )}
                  <span className="flex-1" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs text-muted-foreground"
                    onClick={() => patch({ apiKey: null })}
                  >
                    clear
                  </Button>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  no key yet — buddy can&rsquo;t talk without one
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                value={keyDraft}
                placeholder={settings.apiKeyPresent ? 'paste a new key to replace…' : 'sk-…'}
                autoComplete="off"
                className="h-8 text-xs"
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveKey();
                }}
              />
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={keyDraft.trim().length === 0 || savingKey}
                onClick={() => void saveKey()}
              >
                {justSaved ? 'saved ✓' : 'save'}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              stored encrypted on this device. never shown again, never synced.
            </p>
            <div className="flex min-h-8 items-center gap-2.5">
              <Label htmlFor="model" className="flex-1 text-xs font-normal text-muted-foreground">
                model
              </Label>
              <Select
                value={settings.model}
                onValueChange={(value) => patch({ model: value as ModelId })}
              >
                <SelectTrigger id="model" size="sm" className="max-w-[230px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* ChatGPT-subscription sign-in card. Existing Codex CLI auth is detected,
            and users without it can connect through the system-browser PKCE flow. */}
        <Card className="gap-3 rounded-lg py-3.5 shadow-none">
          <CardHeader className="px-3.5">
            <CardTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              chatgpt
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 px-3.5">
            {settings.codexSignedIn ? (
              <>
                <div className="flex min-h-7 items-center gap-2">
                  {settings.codexValid ? (
                    <Badge
                      variant="outline"
                      className="rounded-full border-emerald-400/40 bg-emerald-400/10 font-medium text-emerald-300"
                    >
                      signed in to ChatGPT
                      {settings.codexPlanType ? ` (${settings.codexPlanType})` : ''}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="rounded-full border-amber-400/40 bg-amber-400/10 font-medium text-amber-300"
                    >
                      chatgpt session expired — reconnect below
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                  buddy uses your chatgpt plan for pointing &amp; agents. voice still needs an
                  openai api key.
                </p>
                <div className="flex min-h-7 items-center gap-2.5 border-t pt-2.5">
                  <Label htmlFor="prefer-api-grounding" className="flex-1 text-xs font-normal text-muted-foreground">
                    use api key for pointing
                  </Label>
                  <Switch
                    id="prefer-api-grounding"
                    checked={settings.preferApiKeyGrounding}
                    onCheckedChange={(checked) => patch({ preferApiKeyGrounding: checked })}
                  />
                </div>
                <div className="flex min-h-7 items-center gap-2.5 border-t pt-2.5">
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
                    onCheckedChange={(checked) => patch({ computerUseEnabled: checked })}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                connect chatgpt to use your plan for pointing and background agents.
              </p>
            )}
            {!settings.codexValid ? (
              <Button type="button" size="sm" className="self-start rounded-full" disabled={signingIn} onClick={() => void signIn()}>
                {signingIn ? 'opening browser…' : 'connect chatgpt'}
              </Button>
            ) : null}
            {signInMessage ? <p className="text-[11px] leading-relaxed text-muted-foreground/80">{signInMessage}</p> : null}
          </CardContent>
        </Card>

        <Card className="gap-3 rounded-lg py-3.5 shadow-none">
          <CardHeader className="px-3.5">
            <CardTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              voice &amp; captions
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 px-3.5">
            <div className="flex min-h-8 items-center gap-2.5">
              <Label htmlFor="voice" className="flex-1 text-xs font-normal text-muted-foreground">
                voice
              </Label>
              <Select value={settings.voice} onValueChange={(value) => patch({ voice: value })}>
                <SelectTrigger id="voice" size="sm" className="max-w-[190px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICES.map((v) => (
                    <SelectItem key={v} value={v} className="text-xs">
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-h-7 items-center gap-2.5">
              <Label
                htmlFor="captions"
                className="flex-1 text-xs font-normal text-muted-foreground"
              >
                captions on screen
              </Label>
              <Switch
                id="captions"
                checked={settings.captionsEnabled}
                onCheckedChange={(checked) => patch({ captionsEnabled: checked })}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="gap-3 rounded-lg py-3.5 shadow-none">
          <CardHeader className="px-3.5">
            <CardTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              microphone
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 px-3.5">
            <div className="flex min-h-8 items-center gap-2.5">
              <Label htmlFor="mic" className="flex-1 text-xs font-normal text-muted-foreground">
                input device
              </Label>
              <Select
                value={settings.micDeviceId === '' ? '__default__' : settings.micDeviceId}
                onValueChange={(value) =>
                  void clicky.selectMic(value === '__default__' ? '' : value)
                }
              >
                <SelectTrigger id="mic" size="sm" className="max-w-[190px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Radix Select forbids value="" — '' (system default) is mapped to a sentinel. */}
                  <SelectItem value="__default__" className="text-xs">
                    system default
                  </SelectItem>
                  {micDevices
                    .filter((d) => d.deviceId !== '' && d.deviceId !== 'default')
                    .map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId} className="text-xs">
                        {d.label || 'microphone'}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {micError ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                couldn&rsquo;t reach a microphone ({micError.toLowerCase()}) — you can still type
                below.
              </p>
            ) : null}
            <div className="flex min-h-7 items-center gap-2.5 border-t pt-2.5">
              <Label
                htmlFor="full-realtime-mode"
                className="flex-1 text-xs font-normal text-muted-foreground"
              >
                full realtime mode
              </Label>
              <Switch
                id="full-realtime-mode"
                checked={settings.fullRealtimeMode}
                onCheckedChange={(checked) => patch({ fullRealtimeMode: checked })}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              keeps the mic open and uses voice activity detection for a natural back-and-forth.
              a fresh screen capture is attached to every speech turn.
            </p>
            <div className="flex min-h-7 items-center gap-2.5">
              <Label className="flex-1 text-xs font-normal text-muted-foreground">
                {settings.fullRealtimeMode ? 'start / stop realtime' : 'push to talk'}
              </Label>
              <Kbd className="border border-b-2 px-2 text-foreground">{settings.hotkeyLabel}</Kbd>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              {settings.fullRealtimeMode
                ? 'press once to activate; press again to deactivate. fixed for now.'
                : 'hold both keys and talk; let go to send. fixed for now.'}
            </p>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2.5 rounded-lg border border-dashed px-3.5 py-2.5 text-xs text-muted-foreground">
          <span>🪄</span>
          <span>agent mode is ready — say “buddy, agent…” to send off research.</span>
        </div>
      </div>
    </ScrollArea>
  );
}
