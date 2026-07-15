import { useEffect, useState } from 'react';
import { SettingsCard } from './SettingsCard';
import {
  INVALID_KEY_COPY,
  REJECTED_KEY_COPY,
  isClearlyMalformedApiKey,
  sessionRejectedApiKey,
} from './api-key-feedback';
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
import type { ModelId, SessionStatus, Settings } from '../../../../shared/types';

const MODELS: { id: ModelId; label: string }[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini (faster, cheaper)' },
  { id: 'gpt-realtime-2.1', label: 'gpt-realtime-2.1 (default — best pointing)' },
];

/** How long the save button reads "saved ✓" after a key save. */
const JUST_SAVED_MS = 2_500;

interface OpenAiCardProps {
  settings: Settings;
  session: SessionStatus | null;
  onPatch: PatchSettings;
}

/** API key save/clear + realtime model picker. */
export function OpenAiCard({ settings, session, onPatch }: OpenAiCardProps): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const rejectedByOpenAi = settings.apiKeyPresent && sessionRejectedApiKey(session);
  const visibleKeyError = keyError ?? (rejectedByOpenAi ? REJECTED_KEY_COPY : null);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    return () => clearTimeout(t);
  }, [justSaved]);

  const saveKey = async (): Promise<void> => {
    const value = keyDraft.trim();
    if (!value || savingKey) return;
    if (isClearlyMalformedApiKey(value)) {
      setJustSaved(false);
      setKeyError(INVALID_KEY_COPY);
      return;
    }
    setSavingKey(true);
    setKeyError(null);
    try {
      if (!(await onPatch({ apiKey: value }))) return;
      setKeyDraft('');
      setJustSaved(true);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    setJustSaved(false);
    try {
      if (!(await onPatch({ apiKey: null }))) return;
      setKeyDraft('');
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
            ) : rejectedByOpenAi ? (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.danger)}
              >
                key rejected — replace it
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className={cn('rounded-full font-medium', STATUS_TINT.positive)}
              >
                key stored ✓
              </Badge>
            )}
            <span className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground"
              disabled={savingKey}
              onClick={() => void clearKey()}
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
          aria-invalid={visibleKeyError !== null}
          onChange={(e) => {
            setKeyDraft(e.target.value);
            setKeyError(null);
            setJustSaved(false);
          }}
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
      {visibleKeyError ? (
        <p role="alert" className="text-[11px] leading-relaxed text-destructive">
          {visibleKeyError}
        </p>
      ) : null}
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
