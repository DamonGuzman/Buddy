/** Vite `?raw` asset imports (the snapper PowerShell script). */
declare module '*.ps1?raw' {
  const content: string;
  export default content;
}
