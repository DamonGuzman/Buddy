import { useEffect, useState } from 'react';
import { normalizeFirecrawlApiKey } from '../../../../shared/api-key';
import type { Settings } from '../../../../shared/types';
import { STATUS_TINT } from '../status-tint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SettingsCard } from './SettingsCard';
import type { PatchSettings } from './patch';

const JUST_SAVED_MS = 2_500;
const INVALID_KEY_COPY =
  'that does not look like a complete Firecrawl API key — paste the full key beginning with fc-.';

interface FirecrawlCardProps {
  settings: Settings;
  onPatch: PatchSettings;
}

export function FirecrawlCard({ settings, onPatch }: FirecrawlCardProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), JUST_SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = async (): Promise<void> => {
    const key = normalizeFirecrawlApiKey(draft);
    if (saving || draft.trim() === '') return;
    if (key === null) {
      setSaved(false);
      setError(INVALID_KEY_COPY);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!(await onPatch({ firecrawlApiKey: key }))) return;
      setDraft('');
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const clear = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      if (!(await onPatch({ firecrawlApiKey: null }))) return;
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard title="firecrawl">
      <div className="flex min-h-7 items-center gap-2">
        {settings.firecrawlApiKeyPresent ? (
          <>
            <Badge
              variant="outline"
              className={cn(
                'rounded-full font-medium',
                settings.firecrawlApiKeyUnreadable ? STATUS_TINT.danger : STATUS_TINT.positive,
              )}
            >
              {settings.firecrawlApiKeyUnreadable
                ? 'saved key unreadable — paste it again'
                : 'key stored ✓'}
            </Badge>
            <span className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground"
              disabled={saving}
              onClick={() => void clear()}
            >
              clear
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            add one key to give helpers complete web research
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={draft}
          placeholder={settings.firecrawlApiKeyPresent ? 'paste a new key to replace…' : 'fc-…'}
          autoComplete="off"
          className="h-8 text-xs"
          aria-invalid={error !== null}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
        />
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={draft.trim().length === 0 || saving}
          onClick={() => void save()}
        >
          {saved ? 'saved ✓' : 'save'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[11px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        used for search, full-page scrape, map, crawl, batch scrape, and research. stored encrypted
        on this device and never sent to OpenAI.
      </p>
    </SettingsCard>
  );
}
