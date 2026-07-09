/**
 * Returns initialization commands to inject right after the shell spawns,
 * adding Linux-compatible aliases/functions so commands like ls, cat, grep, etc. work.
 */
export function getShellInitScript(shellType: string): string {
  switch (shellType) {
    case "cmd": {
      // Set the prompt to emit OSC 1337 with [CWD:path|EXIT:code], ST-terminated
      // ($E\ = ESC+backslash). Three Windows/ConPTY-specific requirements make this work:
      //
      //  1. NON-TITLE OSC (1337, not OSC 0). ConPTY intercepts title-set sequences,
      //     manages the console title itself, and never forwards the child's title to
      //     the output pipe — an OSC 0 marker vanishes and completion is never detected
      //     (the block stays "running" forever and the input bar locks up).
      //  2. ECHO stays ON (no "@ECHO OFF"). With echo off, cmd does not render the
      //     prompt at all, so the marker is never emitted. With echo on, cmd redraws the
      //     prompt (a cursor reposition) after every command, which forces ConPTY to
      //     flush the otherwise-invisible OSC marker. The echoed command line itself is
      //     stripped in the frontend via echoFilter, exactly as on macOS shells (which
      //     also echo through the PTY).
      //  3. The '|' is ESCAPED as '^|'. Unescaped, cmd parses [CWD:$P|EXIT:...] as a
      //     pipeline and mangles the PROMPT value.
      //
      // ST is used instead of BEL because a raw \x07 in a PTY command line can be
      // consumed by ConPTY input processing before reaching cmd. NOTE: %errorlevel% is
      // expanded once when PROMPT is set (cmd has no per-display expansion for it), so
      // cmd blocks always report EXIT:0 — completion/cwd are correct, exit status is not.
      const header = "@PROMPT $E]1337;[CWD:$P^|EXIT:%errorlevel%]$E\\";
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
        // Emit OSC 1337 with [CWD:path|EXIT:code], ST-terminated. $st=[char]0x5c = backslash.
        // OSC 1337 (not OSC 0/title): ConPTY swallows title-set sequences, so an OSC 0
        // marker would never reach the frontend and command completion would go undetected.
        // Exit code must be captured as the prompt function's first statement, before
        // $? / $LASTEXITCODE get clobbered by anything else the function does.
        'function prompt { $__ec=if($?){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}; $e=[char]0x1b; $st=[char]0x5c; "$e]1337;[CWD:$($pwd.Path)|EXIT:$__ec]$e$st" }',
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
      // Hide the default "user@host dir %" prompt and emit OSC 1337 with [CWD:path|EXIT:code]
      // (ST-terminated) via a precmd hook, matching the marker used by pwsh/cmd. $? must be
      // captured as the hook's very first statement, before anything else in it can clobber it.
      // OSC 1337 (not OSC 0/title) so the same marker channel works under Windows ConPTY,
      // which swallows title-set sequences.
      const setup = [
        `__b=$'\\033'`,
        "PS1=''",
        `precmd() { local __ec=$?; printf '%s]1337;[CWD:%s|EXIT:%s]%s\\\\' "$__b" "$PWD" "$__ec" "$__b"; }`,
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
        `__braces_precmd() { local __ec=$?; printf '%s]1337;[CWD:%s|EXIT:%s]%s\\\\' "$__b" "$PWD" "$__ec" "$__b"; }`,
        "PROMPT_COMMAND=__braces_precmd",
      ].join("; ");
      return setup + "\rclear\r";
    }

    default:
      return "";
  }
}
