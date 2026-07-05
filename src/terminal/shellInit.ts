/**
 * Returns initialization commands to inject right after the shell spawns,
 * adding Linux-compatible aliases/functions so commands like ls, cat, grep, etc. work.
 */
export function getShellInitScript(shellType: string): string {
  switch (shellType) {
    case "cmd": {
      // Turn off command echo so typed commands don't appear in xterm output.
      // Set prompt to emit OSC 0 with [CWD:path|EXIT:code], ST-terminated ($E\ = ESC+backslash).
      // Using ST instead of BEL because raw \x07 in a PTY command line can be consumed
      // by ConPTY input processing before reaching cmd. %errorlevel% is a dynamic
      // pseudo-variable cmd resolves at prompt-display-time to the last command's exit code.
      const header = "@ECHO OFF\r\n@PROMPT $E]0;[CWD:$P|EXIT:%errorlevel%]$E\\";
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
        // Emit OSC 0 with [CWD:path|EXIT:code], ST-terminated. $st=[char]0x5c = backslash.
        // Exit code must be captured as the prompt function's first statement, before
        // $? / $LASTEXITCODE get clobbered by anything else the function does.
        'function prompt { $__ec=if($?){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}; $e=[char]0x1b; $st=[char]0x5c; "$e]0;[CWD:$($pwd.Path)|EXIT:$__ec]$e$st" }',
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

    case "zsh": {
      // Hide the default "user@host dir %" prompt and emit OSC 0 with [CWD:path|EXIT:code]
      // (ST-terminated) via a precmd hook, matching the marker used by pwsh/cmd. $? must be
      // captured as the hook's very first statement, before anything else in it can clobber it.
      const setup = [
        `__b=$'\\033'`,
        "PS1=''",
        `precmd() { local __ec=$?; printf '%s]0;[CWD:%s|EXIT:%s]%s\\\\' "$__b" "$PWD" "$__ec" "$__b"; }`,
      ].join("; ");
      return setup + "\rclear\r";
    }

    case "bash": {
      // Same idea as zsh, but bash has no precmd hook — define a function and point
      // PROMPT_COMMAND at its name (a bare name avoids re-parsing quotes/backslashes,
      // since PROMPT_COMMAND's string form is otherwise re-evaluated like typed input).
      const setup = [
        `__b=$'\\033'`,
        "PS1=''",
        `__braces_precmd() { local __ec=$?; printf '%s]0;[CWD:%s|EXIT:%s]%s\\\\' "$__b" "$PWD" "$__ec" "$__b"; }`,
        "PROMPT_COMMAND=__braces_precmd",
      ].join("; ");
      return setup + "\rclear\r";
    }

    default:
      return "";
  }
}
