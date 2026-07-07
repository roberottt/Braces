export type Lang = "en" | "es";

const T = {
  en: {
    // Settings modal
    settings:              "SETTINGS",
    close_hint:            "Close [Esc]",
    tab_appearance:        "Appearance",
    tab_ai:                "AI",
    tab_keys:              "API Keys",
    language:              "Language",
    theme:                 "Theme",
    persist_sessions:      "Session persistence",
    persist_sessions_desc: "Save terminal history and restore it on restart",
    main_provider:         "Main provider",
    model:                 "Model",
    model_placeholder:     "model name",
    local_host:            "Local host",
    local_host_desc:       "Local inference server address",
    autocomplete:          "Autocomplete",
    autocomplete_desc:     "Real-time suggestions as you type commands",
    ai_info:               "The selected provider must have an API key in the API Keys tab (except Ollama and LM Studio, which are local).",
    keys_hint:             "Keys are encrypted with AES-256-GCM and stored in the OS secure vault. They are never exposed to the frontend.",
    key_set_badge:         "● configured",
    key_saved_badge:       "✓ saved",
    save:                  "Save",
    on:                    "ON",
    off:                   "OFF",
    ollama_placeholder:    "http://localhost:11434",
    lmstudio_placeholder:  "http://localhost:1234",

    // General UI
    close:                 "Close",
    refresh:               "Refresh",
    hide_panel:            "Hide panel",
    new_session:           "New session",
    loading:               "Loading…",
    discard:               "Discard",
    discard_yes:           "Yes",
    discard_no:            "No",

    // TabSidebar
    search_sessions_ph:    "Search sessions…",
    new_session_tip:       "New session",
    file_explorer_tip:     "File explorer [Ctrl+Shift+E]",

    // StatusBar tooltips
    source_control_tip:    "Source control [Ctrl+Shift+G]",
    code_review_tip:       "Code review [Ctrl+Shift+R]",
    resource_monitor_tip:  "Resource monitor [Ctrl+Shift+M]",
    settings_tip:          "Settings [Ctrl+,]",
    minimize:              "Minimize",
    maximize:              "Maximize",
    restore_window:        "Restore",

    // AI side panel
    provider_model_tip:    "Provider · active model",
    clear_chat:            "Clear chat",
    new_chat:              "New chat",
    chat_history:          "Chat history",
    no_chats:              "No saved chats",
    delete_chat:           "Delete chat",
    untitled_chat:         "Chat",
    agent_empty:           "Agent mode — I can run commands, commit code, check git status, and more.",
    ai_input_ph:           "Ask or instruct…",
    ai_input_hint:         "↵ send · Shift+↵ newline",

    // Code review panel
    reviewing:             "Reviewing…",
    review_staged:         "Review staged",
    review_staged_sub:     "Staged changes",
    review_worktree_sub:   "Unstaged changes",
    review_no_cwd:         "No active directory.",
    review_no_staged:      "No staged changes.",
    review_no_worktree:    "No changes in the worktree.",
    review_diff_err:       "Error getting diff: ",
    review_empty_hint:     "Click \"Review staged\" or \"Review worktree\" to get an AI code review.",
    review_generating:     "Generating review…",

    // Git panel
    git_not_repo:          "Not a git repository",
    git_clean:             "Working directory clean ✓",
    git_commit_ph:         "Commit message…",
    committing:            "Committing…",
    changes:               "Changes",
    close_diff:            "Close diff",
    discard_confirm_pre:   "Discard \"",
    discard_confirm_post:  "\"?",
    discard_will_delete:   " (will be deleted)",

    // Error panel
    analyzing:             "Analyzing…",
    analysis_failed:       "Analysis failed — is an AI provider configured?",
    analyze:               "ANALYZE",
    apply_fix_hint:        "Ctrl+F to apply fix",

    // WorkspacePanel
    workspace_loading:     "Loading…",

    // NewSessionWelcome shortcuts
    shortcut_new_tab:      "new session / tab",
    shortcut_ai_panel:     "AI panel",
    shortcut_history:      "history search",
    shortcut_settings:     "settings",
    shortcut_metrics:      "system metrics",
    nsw_hint:              "Type a command to start",
    new_session_title:     "◈ NEW SESSION",
    app_subtitle:          "Braces — AI-Native Terminal",

    // App
    show_sessions_tip:     "Show sessions",

    // StatusBar
    ai_panel_tip:          "AI panel [Ctrl+Shift+A]",

    // AI side panel messages
    msg_you:               "YOU",
    msg_ai:                "AI",
    exec_running:          "running…",

    // Git panel
    staged_badge:          "staged",
    worktree_badge:        "worktree",
    commit:                "Commit",
    git_staged_section:    "Staged",
    unstage_all:           "Unstage all",
    stage_all:             "Stage all",
    unstage:               "Unstage",
    stage:                 "Stage",

    // Code review
    code_review_title:     "✓ Code Review",
    review_worktree_btn:   "Review worktree",

    // Workspace panel
    no_read_dir:           "Cannot read directory",
    sessions:              "SESSIONS",
    files_label:           "FILES",

    // Metrics overlay
    system_label:          "SYSTEM",
    ram_query_ph:          "what's eating my RAM?",

    // History overlay
    semantic_history:      "SEMANTIC HISTORY",
    search_commands_ph:    "search commands…",

    // Git diff view
    binary_file:           "Binary file modified",
    no_changes_diff:       "No changes to show",

    // WarpTerminal panels
    branches_panel:        "BRANCHES",
    branch_hint:           "↵ switch  ·  esc close",
    completions_panel:     "COMPLETIONS",
    completions_hint:      "Tab / ↑↓ navigate · ↵ run · esc cancel",
    history_panel_title:   "HISTORY",
    history_panel_hint:    "↑↓ navigate · ↵ select · esc close",
    switch_branch_tip:     "Switch branch",
    view_changes_tip:      "View changes (Ctrl+Shift+G)",
    run_commands_ph:       "Run commands…",
    connecting_ph:         "Connecting…",
    running_locked_ph:     "Command running — Ctrl+C to stop",
    stop_cmd_tip:          "Stop command (Ctrl+C)",

    // Editor view
    editor_view_tip:       "Editor [Ctrl+E]",
    editor_close_tab:      "Close tab",
    editor_unsaved_pre:    "Unsaved changes in ",
    editor_unsaved_post:   ". Save before closing?",
    editor_close_save:     "Save & close",
    editor_close_discard:  "Discard & close",
    no_file_open:          "No file open — pick one from the tree on the left",
  },
  es: {
    // Settings modal
    settings:              "CONFIGURACIÓN",
    close_hint:            "Cerrar [Esc]",
    tab_appearance:        "Apariencia",
    tab_ai:                "IA",
    tab_keys:              "API Keys",
    language:              "Idioma",
    theme:                 "Tema",
    persist_sessions:      "Persistencia de sesiones",
    persist_sessions_desc: "Guarda el historial de la terminal y lo restaura al reiniciar",
    main_provider:         "Proveedor principal",
    model:                 "Modelo",
    model_placeholder:     "nombre del modelo",
    local_host:            "Host local",
    local_host_desc:       "Dirección del servidor local de inferencia",
    autocomplete:          "Autocompletado",
    autocomplete_desc:     "Sugerencias en tiempo real mientras escribes comandos",
    ai_info:               "El proveedor seleccionado debe tener una API key en la pestaña API Keys (excepto Ollama y LM Studio, que son locales).",
    keys_hint:             "Las keys se cifran con AES-256-GCM y se guardan en el almacén seguro del sistema operativo. Nunca se exponen al frontend.",
    key_set_badge:         "● configurada",
    key_saved_badge:       "✓ guardada",
    save:                  "Guardar",
    on:                    "ON",
    off:                   "OFF",
    ollama_placeholder:    "http://localhost:11434",
    lmstudio_placeholder:  "http://localhost:1234",

    // General UI
    close:                 "Cerrar",
    refresh:               "Actualizar",
    hide_panel:            "Ocultar panel",
    new_session:           "Nueva sesión",
    loading:               "Cargando…",
    discard:               "Descartar",
    discard_yes:           "Sí",
    discard_no:            "No",

    // TabSidebar
    search_sessions_ph:    "Buscar sesiones…",
    new_session_tip:       "Nueva sesión",
    file_explorer_tip:     "Explorador de archivos [Ctrl+Shift+E]",

    // StatusBar tooltips
    source_control_tip:    "Control de código [Ctrl+Shift+G]",
    code_review_tip:       "Revisión de código [Ctrl+Shift+R]",
    resource_monitor_tip:  "Monitor de recursos [Ctrl+Shift+M]",
    settings_tip:          "Configuración [Ctrl+,]",
    minimize:              "Minimizar",
    maximize:              "Maximizar",
    restore_window:        "Restaurar",

    // AI side panel
    provider_model_tip:    "Proveedor · modelo activo",
    clear_chat:            "Borrar chat",
    new_chat:              "Nuevo chat",
    chat_history:          "Historial de chats",
    no_chats:              "Sin chats guardados",
    delete_chat:           "Eliminar chat",
    untitled_chat:         "Chat",
    agent_empty:           "Modo agente — puedo ejecutar comandos, hacer commits, ver estado de git y más.",
    ai_input_ph:           "Pregunta o da instrucciones…",
    ai_input_hint:         "↵ enviar · Shift+↵ nueva línea",

    // Code review panel
    reviewing:             "Revisando…",
    review_staged:         "Revisar staged",
    review_staged_sub:     "Cambios en el área de staging",
    review_worktree_sub:   "Cambios sin stagear",
    review_no_cwd:         "No hay un directorio activo.",
    review_no_staged:      "No hay cambios staged.",
    review_no_worktree:    "No hay cambios en el worktree.",
    review_diff_err:       "Error al obtener diff: ",
    review_empty_hint:     "Haz clic en \"Revisar staged\" o \"Review worktree\" para obtener una revisión de código por IA.",
    review_generating:     "Generando revisión…",

    // Git panel
    git_not_repo:          "No es un repositorio git",
    git_clean:             "Directorio de trabajo limpio ✓",
    git_commit_ph:         "Mensaje del commit…",
    committing:            "Confirmando…",
    changes:               "Cambios",
    close_diff:            "Cerrar diff",
    discard_confirm_pre:   "¿Descartar \"",
    discard_confirm_post:  "\"?",
    discard_will_delete:   " (se eliminará)",

    // Error panel
    analyzing:             "Analizando…",
    analysis_failed:       "Análisis fallido — ¿hay un proveedor de IA configurado?",
    analyze:               "ANALIZAR",
    apply_fix_hint:        "Ctrl+F para aplicar la corrección",

    // WorkspacePanel
    workspace_loading:     "Cargando…",

    // NewSessionWelcome shortcuts
    shortcut_new_tab:      "nueva sesión / pestaña",
    shortcut_ai_panel:     "panel de IA",
    shortcut_history:      "búsqueda en historial",
    shortcut_settings:     "configuración",
    shortcut_metrics:      "métricas del sistema",
    nsw_hint:              "Escribe un comando para comenzar",
    new_session_title:     "◈ NUEVA SESIÓN",
    app_subtitle:          "Braces — Terminal con IA nativa",

    // App
    show_sessions_tip:     "Mostrar sesiones",

    // StatusBar
    ai_panel_tip:          "Panel de IA [Ctrl+Shift+A]",

    // AI side panel messages
    msg_you:               "TÚ",
    msg_ai:                "IA",
    exec_running:          "ejecutando…",

    // Git panel
    staged_badge:          "staged",
    worktree_badge:        "worktree",
    commit:                "Confirmar",
    git_staged_section:    "En staging",
    unstage_all:           "Quitar todo",
    stage_all:             "Agregar todo",
    unstage:               "Quitar",
    stage:                 "Agregar",

    // Code review
    code_review_title:     "✓ Revisión de Código",
    review_worktree_btn:   "Revisar worktree",

    // Workspace panel
    no_read_dir:           "No se puede leer el directorio",
    sessions:              "SESIONES",
    files_label:           "ARCHIVOS",

    // Metrics overlay
    system_label:          "SISTEMA",
    ram_query_ph:          "¿qué consume mi RAM?",

    // History overlay
    semantic_history:      "HISTORIAL SEMÁNTICO",
    search_commands_ph:    "buscar comandos…",

    // Git diff view
    binary_file:           "Archivo binario modificado",
    no_changes_diff:       "Sin cambios para mostrar",

    // WarpTerminal panels
    branches_panel:        "RAMAS",
    branch_hint:           "↵ cambiar  ·  esc cerrar",
    completions_panel:     "COMPLETADOS",
    completions_hint:      "Tab / ↑↓ navegar · ↵ ejecutar · esc cancelar",
    history_panel_title:   "HISTORIAL",
    history_panel_hint:    "↑↓ navegar · ↵ seleccionar · esc cerrar",
    switch_branch_tip:     "Cambiar de rama",
    view_changes_tip:      "Ver cambios (Ctrl+Shift+G)",
    run_commands_ph:       "Ejecutar comandos…",
    connecting_ph:         "Conectando…",
    running_locked_ph:     "Comando en ejecución — Ctrl+C para detener",
    stop_cmd_tip:          "Detener comando (Ctrl+C)",

    // Editor view
    editor_view_tip:       "Editor [Ctrl+E]",
    editor_close_tab:      "Cerrar pestaña",
    editor_unsaved_pre:    "Cambios sin guardar en ",
    editor_unsaved_post:   ". ¿Guardar antes de cerrar?",
    editor_close_save:     "Guardar y cerrar",
    editor_close_discard:  "Descartar y cerrar",
    no_file_open:          "Ningún archivo abierto — elegí uno del árbol de la izquierda",
  },
} as const;

export type TKey = keyof typeof T.en;

export function t(lang: Lang, key: TKey): string {
  return T[lang][key];
}
