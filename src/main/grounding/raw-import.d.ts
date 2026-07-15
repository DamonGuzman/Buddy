/** Vite `?raw` asset imports (the Windows snapper PowerShell script). */
declare module '*.ps1?raw' {
  const content: string;
  export default content;
}
