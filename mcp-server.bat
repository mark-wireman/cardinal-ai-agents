@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Gemini-Apigee MCP Server - Batch / cURL Edition
:: ============================================================
:: Requires: curl, jq (https://jqlang.github.io/jq/)
::
:: Environment variables (set in this file or export before running):
::   APIGEE_ENDPOINT  - Apigee token endpoint URL
::   APIGEE_KEY       - Apigee API key
::   APIGEE_SECRET    - Apigee API secret
::   GEMINI_ENDPOINT  - Gemini API endpoint URL
:: ============================================================

:: -------------------------------------------------------
:: Load .env file if it exists
:: -------------------------------------------------------
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" (
            set "%%A=%%B"
        )
    )
)

:: -------------------------------------------------------
:: Validate required environment variables
:: -------------------------------------------------------
call :validate_env APIGEE_ENDPOINT || exit /b 1
call :validate_env APIGEE_KEY      || exit /b 1
call :validate_env APIGEE_SECRET   || exit /b 1
call :validate_env GEMINI_ENDPOINT || exit /b 1

:: -------------------------------------------------------
:: Route to the requested command
:: -------------------------------------------------------
if "%~1"=="" goto :usage
if /i "%~1"=="ask_gemini"      goto :ask_gemini
if /i "%~1"=="deep_rl_agent"   goto :deep_rl_agent
goto :usage

:: ============================================================
:: COMMAND: ask_gemini
:: Usage:  mcp-server.bat ask_gemini "Your prompt here"
:: ============================================================
:ask_gemini
if "%~2"=="" (
    echo ERROR: Missing prompt argument.
    echo Usage: %~nx0 ask_gemini "Your prompt here"
    exit /b 1
)

call :get_apigee_token
if errorlevel 1 (
    echo ERROR: Failed to obtain Apigee token.
    exit /b 1
)

call :call_gemini "%~2"
exit /b %errorlevel%

:: ============================================================
:: COMMAND: deep_rl_agent
:: Usage:  mcp-server.bat deep_rl_agent "user story text" [requirement_context | codebase_path provider]
:: ============================================================
:deep_rl_agent
set "DEEP_RL_BINARY=%~dp0deep-rl-cpp-master\build\deep_rl_agent"

if not exist "!DEEP_RL_BINARY!" (
    if not exist "!DEEP_RL_BINARY!.exe" (
        echo ERROR: Deep RL Agent binary not found at !DEEP_RL_BINARY!
        echo Build it with: cd deep-rl-cpp-master\build ^&^& cmake .. ^&^& make
        exit /b 1
    ) else (
        set "DEEP_RL_BINARY=!DEEP_RL_BINARY!.exe"
    )
)

if "%~2"=="" (
    echo ERROR: Missing user_story argument.
    echo Usage: %~nx0 deep_rl_agent "user story text" [requirement_context]
    echo    or: %~nx0 deep_rl_agent "user story text" codebase_path [provider]
    exit /b 1
)

set "USER_STORY=%~2"

:: Detect mode: if 3rd arg looks like a path, treat as code mode
if "%~3"=="" (
    echo [Mode] user_story ^(story-only^)
    "!DEEP_RL_BINARY!" "%USER_STORY%"
    goto :deep_rl_done
)

:: Check if 3rd arg is a directory (code mode) or plain text (requirement context)
if exist "%~3\" (
    goto :deep_rl_code_mode
)
if exist "%~3" (
    goto :deep_rl_code_mode
)

:: Assume it's requirement_context for story-only mode
echo [Mode] user_story ^(with requirement context^)
"!DEEP_RL_BINARY!" "%USER_STORY%" "%~3"
goto :deep_rl_done

:deep_rl_code_mode
set "CODEBASE_PATH=%~3"
set "PROVIDER=%~4"
if "!PROVIDER!"=="" set "PROVIDER=gemini_apigee"

echo [Mode] code ^(provider: !PROVIDER!^)

if /i "!PROVIDER!"=="gemini_apigee" (
    call :get_apigee_token
    if errorlevel 1 (
        echo ERROR: Failed to obtain Apigee token for deep_rl_agent code mode.
        exit /b 1
    )
    "!DEEP_RL_BINARY!" "!CODEBASE_PATH!" "!GEMINI_ENDPOINT!" "!APIGEE_TOKEN!" "%USER_STORY%"
    goto :deep_rl_done
)

if /i "!PROVIDER!"=="anthropic" (
    if "%~5"=="" (
        echo ERROR: anthropic provider requires api_key as 5th argument.
        exit /b 1
    )
    "!DEEP_RL_BINARY!" "!CODEBASE_PATH!" "%~5" "%USER_STORY%"
    goto :deep_rl_done
)

if /i "!PROVIDER!"=="ollama" (
    if "%~5"=="" (
        echo ERROR: ollama provider requires ollama_base_url as 5th argument.
        exit /b 1
    )
    set "OLLAMA_MODEL=%~6"
    if "!OLLAMA_MODEL!"=="" set "OLLAMA_MODEL=llama3"
    "!DEEP_RL_BINARY!" "!CODEBASE_PATH!" "%~5" "!OLLAMA_MODEL!" "%USER_STORY%"
    goto :deep_rl_done
)

if /i "!PROVIDER!"=="generic" (
    if "%~5"=="" (
        echo ERROR: generic provider requires endpoint_url as 5th argument.
        exit /b 1
    )
    if not "%~6"=="" (
        "!DEEP_RL_BINARY!" "!CODEBASE_PATH!" "%~5" "%~6" "%USER_STORY%"
    ) else (
        "!DEEP_RL_BINARY!" "!CODEBASE_PATH!" "%~5" "%USER_STORY%"
    )
    goto :deep_rl_done
)

echo ERROR: Unsupported provider: !PROVIDER!
echo Expected one of: gemini_apigee, anthropic, ollama, generic
exit /b 1

:deep_rl_done
exit /b %errorlevel%

:: ============================================================
:: FUNCTION: get_apigee_token
:: Sets APIGEE_TOKEN on success
:: ============================================================
:get_apigee_token
echo Authenticating with Apigee...

:: Build the request body as a temp file to avoid escaping issues
set "BODY_FILE=%TEMP%\mcp_apigee_body_%RANDOM%.json"
echo {"grant_type":"client_credentials"}> "!BODY_FILE!"

:: Call Apigee token endpoint
set "TOKEN_FILE=%TEMP%\mcp_apigee_token_%RANDOM%.json"
curl -s -X POST "!APIGEE_ENDPOINT!" ^
    -H "Content-Type: application/json" ^
    -H "X-API-Key: !APIGEE_KEY!" ^
    -H "X-API-Secret: !APIGEE_SECRET!" ^
    -d @"!BODY_FILE!" ^
    -o "!TOKEN_FILE!"

if errorlevel 1 (
    echo ERROR: curl request to Apigee failed.
    del "!BODY_FILE!" 2>nul
    del "!TOKEN_FILE!" 2>nul
    exit /b 1
)

del "!BODY_FILE!" 2>nul

:: Extract access_token using jq (if available) or findstr fallback
where jq >nul 2>&1
if %errorlevel%==0 (
    for /f "usebackq delims=" %%T in (`jq -r ".access_token" "!TOKEN_FILE!"`) do set "APIGEE_TOKEN=%%T"
) else (
    :: Fallback: crude extraction without jq
    for /f "tokens=2 delims=:," %%T in ('findstr /i "access_token" "!TOKEN_FILE!"') do (
        set "APIGEE_TOKEN=%%~T"
        :: Remove surrounding quotes and spaces
        set "APIGEE_TOKEN=!APIGEE_TOKEN: =!"
        set "APIGEE_TOKEN=!APIGEE_TOKEN:"=!"
    )
)

del "!TOKEN_FILE!" 2>nul

if "!APIGEE_TOKEN!"=="" (
    echo ERROR: Could not extract access_token from Apigee response.
    exit /b 1
)

echo Authentication successful.
exit /b 0

:: ============================================================
:: FUNCTION: call_gemini
:: %~1 = prompt text
:: ============================================================
:call_gemini
set "PROMPT=%~1"

:: Escape double quotes and special chars for JSON
set "PROMPT_ESCAPED=!PROMPT:"=\"!"

:: Build request body via temp file
set "GEMINI_BODY_FILE=%TEMP%\mcp_gemini_body_%RANDOM%.json"
echo {"contents":[{"parts":[{"text":"!PROMPT_ESCAPED!"}]}]}> "!GEMINI_BODY_FILE!"

set "GEMINI_RESP_FILE=%TEMP%\mcp_gemini_resp_%RANDOM%.json"

echo Calling Gemini...
curl -s -X POST "!GEMINI_ENDPOINT!" ^
    -H "Content-Type: application/json" ^
    -H "Authorization: Bearer !APIGEE_TOKEN!" ^
    -d @"!GEMINI_BODY_FILE!" ^
    -o "!GEMINI_RESP_FILE!"

if errorlevel 1 (
    echo ERROR: curl request to Gemini failed.
    del "!GEMINI_BODY_FILE!" 2>nul
    del "!GEMINI_RESP_FILE!" 2>nul
    exit /b 1
)

del "!GEMINI_BODY_FILE!" 2>nul

:: Extract response text
where jq >nul 2>&1
if %errorlevel%==0 (
    echo.
    echo === Gemini Response ===
    jq -r ".candidates[0].content.parts[0].text" "!GEMINI_RESP_FILE!"
) else (
    echo.
    echo === Gemini Response (raw JSON) ===
    type "!GEMINI_RESP_FILE!"
)

del "!GEMINI_RESP_FILE!" 2>nul
exit /b 0

:: ============================================================
:: FUNCTION: validate_env
:: %~1 = variable name
:: ============================================================
:validate_env
if "!%~1!"=="" (
    echo ERROR: Required environment variable %~1 is not set.
    exit /b 1
)
exit /b 0

:: ============================================================
:: Usage
:: ============================================================
:usage
echo.
echo Gemini-Apigee MCP Server - Batch / cURL Edition
echo.
echo Usage:
echo   %~nx0 ask_gemini "Your prompt here"
echo   %~nx0 deep_rl_agent "user story" [requirement_context]
echo   %~nx0 deep_rl_agent "user story" codebase_path [provider] [extra_args...]
echo.
echo Commands:
echo   ask_gemini       Send a prompt to Gemini AI through Apigee
echo   deep_rl_agent    Run Deep RL multi-agent analysis
echo.
echo Providers (for deep_rl_agent code mode):
echo   gemini_apigee    Uses GEMINI_ENDPOINT + Apigee token (default)
echo   anthropic        Requires api_key as next argument
echo   ollama           Requires ollama_base_url [ollama_model] as next arguments
echo   generic          Requires endpoint_url [token] as next arguments
echo.
echo Environment variables (or set in .env file):
echo   APIGEE_ENDPOINT  Apigee token endpoint URL
echo   APIGEE_KEY       Apigee API key
echo   APIGEE_SECRET    Apigee API secret
echo   GEMINI_ENDPOINT  Gemini API endpoint URL
echo.
exit /b 0
