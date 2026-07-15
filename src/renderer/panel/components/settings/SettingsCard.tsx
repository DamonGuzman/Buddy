import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface SettingsCardProps {
  title: React.ReactNode;
  children: React.ReactNode;
}

/** Shared shell for the settings cards: tracked-caps title + stacked content. */
export function SettingsCard({ title, children }: SettingsCardProps): React.JSX.Element {
  return (
    <Card className="gap-3 rounded-lg py-3.5 shadow-none">
      <CardHeader className="px-3.5">
        <CardTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-3.5">{children}</CardContent>
    </Card>
  );
}
