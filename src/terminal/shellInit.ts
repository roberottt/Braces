/**
 * Returns initialization commands to inject right after the shell spawns,
 * adding Linux-compatible aliases/functions so commands like ls, cat, grep, etc. work.
 */
export function getShellInitScript(shellType: string): string {
  switch (shellType) {
    case "cmd": {
      // Turn off command echo so typed commands don't appear in xterm output.
      // Set prompt to emit OSC 0 with [CWD:path], ST-terminated ($E\ = ESC+backslash).
      // Using ST instead of BEL because raw \x07 in a PTY command line can be consumed
      // by ConPTY input processing before reaching cmd.
      const header = "@ECHO OFF\r\n@PROMPT $E]0;[CWD:$P]$E\\";
      const macros = [
        "ls=dir /b $*",
        "ll=dir $*",
        "la=dir /b /a $*",
        "clear=cls",
        "cat=type $*",
        "pwd=cd",
        "rm=del /q $*",
        "cp=copy $*",
        "mv=move $*",
        "which=where $*",
        "grep=findstr $*",
        "man=help $*",
        "ps=tasklist",
        "kill=taskkill /pid $1 /f",
      ].map(m => `@doskey ${m}`).join("\r\n");
      return header + "\r\n" + macros + "\r\n@cls\r\n";
    }

    case "pwsh": {
      // PS7 already has: ls, cat, rm, cp, mv, mkdir, echo, pwd, clear, sort
      const fns = [
        // Emit OSC 0 with [CWD:path], ST-terminated. $st=[char]0x5c = backslash.
        'function prompt { $e=[char]0x1b; $st=[char]0x5c; "$e]0;[CWD:$($pwd.Path)]$e$st" }',
        // touch: create file or update mtime
        "function touch { param([string[]]$f) foreach ($p in $f) { if (!(Test-Path $p)) { New-Item -ItemType File $p | Out-Null } else { (Get-Item $p).LastWriteTime = Get-Date } } }",
        // grep wrapper → Select-String
        "function grep { param([string]$pat,[string]$file) if ($file) { Select-String -Pattern $pat -Path $file } else { $input | Select-String -Pattern $pat } }",
        // which → Get-Command source
        "function which { param([string]$c) (Get-Command $c -EA SilentlyContinue).Source }",
        // find → Get-ChildItem -Recurse
        "function find { param([string]$path='.',[string]$name='*') Get-ChildItem -Recurse -Filter $name $path }",
        // head / tail
        "function head { param([int]$n=10) $input | Select-Object -First $n }",
        "function tail { param([int]$n=10) $input | Select-Object -Last $n }",
      ].join("; ");
      return fns + "\r\nClear-Host\r\n";
    }

    default:
      return "";
  }
}
