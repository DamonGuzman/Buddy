import { useEffect, useState } from 'react';
import { SettingsCard } from './SettingsCard';
import { STATUS_TINT } from '../status-tint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { PatchSettings } from './patch';
import type { ModelId, Settings } from '../../../../shared/types';

const MODELS: { id: ModelId; label: string }[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini (faster, cheaper)' },
  { id: 'gpt-realtime-2.1', label: 'gpt-realtime-2.1 (default — best pointing)' },
];

/** How long the save button reads "saved ✓" after a key save. */
const JUST_SAVED_MS = 2_500;

interface OpenAiCardProps {
  settings: Settings;
  onPatch: PatchSettings;
}

/** API key save/clear + realtime model picker. */
export function OpenAiCard({ settings, onPatch }: OpenAiCardProps): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    return () => clearTimeout(t);
  }, [justSaved]);

  const saveKey = async (): Promise<void> => {
    const value = keyDraft.trim();
    if (!value || savingKey) return;
    setSavingKey(true);
    try {
      await onPatch({ apiKey: value });
      setKeyDraft('');
      setJustSaved(true);
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <SettingsCard title="openai">
      <div className="flex min-h-7 items-center gap-2">
        {settings.apiKeyPresent ? (
          <>
            {/* M11 UI (deferred by the error-catalog agent, built at M16):
                a stored blob that DPAPI can no longer decrypt reads as
                present-but-dead. Warn instead of the green "saved" badge
                so the user knows to paste the key again. */}
            {settings.apiKeyUnreadable ? (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.danger)}
              >
                saved key unreadable — paste it again
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.positive)}
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
              onClick={() => void onPatch({ apiKey: null })}
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
          onValueChange={(value) => void onPatch({ model: value as ModelId })}
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
    </SettingsCard>
  );
}
