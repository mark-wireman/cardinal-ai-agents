package com.cardinalhealth.localagentstudio

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.Base64
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTabbedPane
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import javax.swing.text.html.HTMLDocument
import javax.swing.text.html.HTMLEditorKit

data class AgentDefinition(
    val name: String,
    val description: String,
    val systemPrompt: String,
    val filePath: String,
)

data class ConversationTurn(val role: String, val text: String)

object EnvReader {
    fun read(repoRoot: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val processEnv = System.getenv()
        listOf("APIGEE_ENDPOINT", "APIGEE_KEY", "APIGEE_SECRET", "GEMINI_ENDPOINT").forEach { k ->
            val v = processEnv[k]
            if (!v.isNullOrBlank()) result[k] = v
        }

        val envFile = File(repoRoot, ".env")
        if (!envFile.exists()) return result

        envFile.forEachLine { line ->
            val trimmed = line.trim()
            if (trimmed.startsWith("#") || !trimmed.contains("=")) return@forEachLine
            val idx = trimmed.indexOf('=')
            val key = trimmed.substring(0, idx).trim()
            var value = trimmed.substring(idx + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
                value = value.substring(1, value.length - 1)
            }
            result[key] = value
        }
        return result
    }
}

class GeminiClient(private val env: Map<String, String>) {
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build()
    private var cachedToken: String? = null
    private var tokenExpiresAt: Long = 0L

    private fun getToken(): String {
        if (cachedToken != null && System.currentTimeMillis() < tokenExpiresAt) return cachedToken!!

        val endpoint = env["APIGEE_ENDPOINT"] ?: throw IllegalStateException("APIGEE_ENDPOINT not set in .env")
        val key = env["APIGEE_KEY"] ?: throw IllegalStateException("APIGEE_KEY not set in .env")
        val secret = env["APIGEE_SECRET"] ?: throw IllegalStateException("APIGEE_SECRET not set in .env")

        val basicCreds = Base64.getEncoder().encodeToString("$key:$secret".toByteArray(StandardCharsets.UTF_8))
        val attempts = mutableListOf<Pair<Int, String>>()

        // Primary: OAuth2 client credentials with Basic auth + form body.
        val reqBasic = HttpRequest.newBuilder()
            .uri(URI.create(endpoint))
            .POST(HttpRequest.BodyPublishers.ofString("grant_type=client_credentials"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .header("Authorization", "Basic $basicCreds")
            .timeout(Duration.ofSeconds(30))
            .build()

        var authResp = http.send(reqBasic, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        var json = authResp.body()
        attempts.add(authResp.statusCode() to compact(json))

        // Fallback: explicit client_id/client_secret form fields for gateways that don't accept Basic header.
        if (authResp.statusCode() !in 200..299) {
            val encodedKey = java.net.URLEncoder.encode(key, StandardCharsets.UTF_8)
            val encodedSecret = java.net.URLEncoder.encode(secret, StandardCharsets.UTF_8)
            val body = "grant_type=client_credentials&client_id=$encodedKey&client_secret=$encodedSecret"
            val reqBody = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
                .timeout(Duration.ofSeconds(30))
                .build()

            authResp = http.send(reqBody, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
            json = authResp.body()
            attempts.add(authResp.statusCode() to compact(json))
        }

        if (authResp.statusCode() !in 200..299) {
            val details = attempts.joinToString(" | ") { "${it.first}: ${it.second}" }
            throw IllegalStateException("Apigee auth failed. Attempts -> $details")
        }

        val tokenMatch = Regex("\"access_token\"\\s*:\\s*\"([^\"]+)\"").find(json)
            ?: throw IllegalStateException("No access_token in Apigee response")
        val expiresIn = Regex("\"expires_in\"\\s*:\\s*(\\d+)").find(json)
            ?.groupValues?.get(1)?.toLongOrNull() ?: 3600L

        cachedToken = tokenMatch.groupValues[1]
        tokenExpiresAt = System.currentTimeMillis() + (expiresIn - 300) * 1000L
        return cachedToken!!
    }

    fun callGemini(systemPrompt: String, conversation: List<ConversationTurn>): String {
        val token = getToken()
        val endpoint = env["GEMINI_ENDPOINT"] ?: throw IllegalStateException("GEMINI_ENDPOINT not set in .env")

        val prompt = buildString {
            append(systemPrompt.trim())
            append("\n\nConversation:\n")
            for (turn in conversation) {
                val label = if (turn.role == "user") "User" else "Assistant"
                append(label).append(": ").append(turn.text).append("\n")
            }
        }

        // Match the working Node implementation payload shape used by mcp-server.js.
        val requestBody = "{\"contents\":[{\"parts\":[{\"text\":${jsonString(prompt)}}]}]}"
        val req = HttpRequest.newBuilder()
            .uri(URI.create(endpoint))
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
            .timeout(Duration.ofSeconds(120))
            .build()

        val geminiResp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        val response = geminiResp.body()
        if (geminiResp.statusCode() !in 200..299) {
            throw IllegalStateException("Gemini call failed (${geminiResp.statusCode()}): ${compact(response)}")
        }

        val m = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(response)
            ?: throw IllegalStateException("Could not parse Gemini response: ${compact(response)}")
        return m.groupValues[1]
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    }

    private fun compact(raw: String): String {
        val oneLine = raw.replace(Regex("\\s+"), " ").trim()
        return if (oneLine.length > 240) oneLine.substring(0, 240) + "..." else oneLine
    }

    private fun jsonString(s: String): String {
        val escaped = s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }
}

object AgentDiscovery {
    fun discover(repoRoot: String): List<AgentDefinition> {
        val candidates = linkedSetOf<File>()
        val dirs = listOf(
            File(repoRoot, ".github/agents"),
            File(repoRoot, ".claude/agents"),
            File(repoRoot, "vs-code-local-agent-ui"),
        )

        for (dir in dirs) {
            if (!dir.exists() || !dir.isDirectory) continue

            // Prefer explicit agent files and then fallback to markdown files in known agent folders.
            dir.walkTopDown()
                .maxDepth(2)
                .filter { f ->
                    f.isFile && (
                        f.name.endsWith(".agent.md") ||
                            (dir.path.endsWith(".github${File.separator}agents") && f.name.endsWith(".md"))
                        )
                }
                .forEach { candidates.add(it) }

            if (candidates.isEmpty() && dir.path.endsWith(".github${File.separator}agents")) {
                dir.listFiles { f -> f.isFile && f.name.endsWith(".md") }?.forEach { candidates.add(it) }
            }
        }

        val parsed = candidates
            .mapNotNull { parseAgentFile(it) }
            .sortedBy { it.name.lowercase() }

        if (parsed.isNotEmpty()) return parsed

        // Fallback: search the repo for explicit *.agent.md files.
        return File(repoRoot).walkTopDown()
            .maxDepth(5)
            .filter { it.isFile && it.name.endsWith(".agent.md") }
            .mapNotNull { parseAgentFile(it) }
            .sortedBy { it.name.lowercase() }
            .toList()
    }

    private fun parseAgentFile(file: File): AgentDefinition? {
        val raw = try { file.readText() } catch (_: Exception) { return null }
        val fmMatch = Regex("^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$").find(raw)
        val (meta, body) = if (fmMatch != null) {
            val m = mutableMapOf<String, String>()
            fmMatch.groupValues[1].lines().forEach { line ->
                val kv = Regex("^([\\w-]+):\\s*(.*)$").find(line)
                if (kv != null) m[kv.groupValues[1]] = kv.groupValues[2].trim().trim('"', '\'')
            }
            m to fmMatch.groupValues[2].trim()
        } else {
            emptyMap<String, String>() to raw.trim()
        }

        if (body.isBlank()) return null
        if (!file.name.endsWith(".agent.md") && !file.parentFile.path.endsWith(".github${File.separator}agents")) {
            return null
        }

        val stem = file.name.removeSuffix(".agent.md").removeSuffix(".md")
        val name = meta["name"] ?: stem.replace(Regex("[-_]"), " ")
            .split(" ").joinToString(" ") { it.replaceFirstChar { c -> c.uppercaseChar() } }
        val description = meta["description"] ?: "Custom agent"
        return AgentDefinition(name, description, body, file.absolutePath)
    }
}

object MarkdownRenderer {
    fun toHtml(md: String): String {
        val sb = StringBuilder()
        var inCode = false
        for (line in md.lines()) {
            when {
                line.startsWith("```") -> {
                    if (!inCode) {
                        inCode = true
                        sb.append("<pre style='background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px;font-family:monospace;font-size:12px;white-space:pre-wrap;'>")
                    } else {
                        inCode = false
                        sb.append("</pre>")
                    }
                }
                inCode -> sb.append(htmlEncode(line)).append("\n")
                line.startsWith("### ") -> sb.append("<h3 style='color:#9cdcfe;margin:4px 0 2px;'>${inline(line.drop(4))}</h3>")
                line.startsWith("## ") -> sb.append("<h2 style='color:#9cdcfe;margin:6px 0 2px;'>${inline(line.drop(3))}</h2>")
                line.startsWith("# ") -> sb.append("<h1 style='color:#9cdcfe;margin:8px 0 2px;'>${inline(line.drop(2))}</h1>")
                line.startsWith("- ") || line.startsWith("* ") -> sb.append("<li>${inline(line.drop(2))}</li>")
                line.matches(Regex("^\\d+\\. .*")) -> sb.append("<li>${inline(line.substringAfter(". "))}</li>")
                line.isBlank() -> sb.append("<br/>")
                else -> sb.append("<p style='margin:2px 0;'>${inline(line)}</p>")
            }
        }
        return sb.toString()
    }

    private fun inline(text: String): String {
        var s = htmlEncode(text)
        s = s.replace(Regex("`([^`]+)`"), "<code style='background:#1e1e1e;color:#d4d4d4;padding:1px 3px;border-radius:2px;font-family:monospace;'>$1</code>")
        s = s.replace(Regex("\\*\\*([^*]+)\\*\\*"), "<strong>$1</strong>")
        s = s.replace(Regex("\\*([^*]+)\\*"), "<em>$1</em>")
        return s
    }

    private fun htmlEncode(s: String) = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
}

class LocalAgentStudioToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = LocalAgentStudioPanel(project)
        val content = ContentFactory.getInstance().createContent(panel.root, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

private class LocalAgentStudioPanel(private val project: Project) {
    val root: JPanel = JPanel(BorderLayout())
    private val repoRootField = TextFieldWithBrowseButton()

    private val servicesOutput = JTextArea()
    private val servicesStatus = JLabel("Ready")

    private val agentCombo = JComboBox<String>()
    private val agents = mutableListOf<AgentDefinition>()
    private val conversation = mutableListOf<ConversationTurn>()
    private val promptArea = JTextArea(4, 40)
    private val responsePane = JEditorPane()
    private val agentStatus = JLabel("Select an agent and enter a prompt")
    @Volatile private var runThread: Thread? = null

    init {
        val detected = detectRepoRoot(project.basePath)
        repoRootField.text = detected ?: (project.basePath ?: "")
        repoRootField.addBrowseFolderListener(
            "Select Agents Deployment Package Root",
            "Select the root folder containing deploy-intellij.ps1",
            project,
            FileChooserDescriptorFactory.createSingleFolderDescriptor(),
        )
        repoRootField.textField.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) = scheduleAgentRefresh()
            override fun removeUpdate(e: DocumentEvent?) = scheduleAgentRefresh()
            override fun changedUpdate(e: DocumentEvent?) = scheduleAgentRefresh()
        })

        val repoPanel = JPanel(GridBagLayout())
        val gbc = GridBagConstraints().apply { insets = Insets(2, 2, 2, 2) }
        gbc.gridx = 0; gbc.gridy = 0; gbc.weightx = 0.0; gbc.fill = GridBagConstraints.NONE
        repoPanel.add(JLabel("Repo Root:"), gbc)
        gbc.gridx = 1; gbc.weightx = 1.0; gbc.fill = GridBagConstraints.HORIZONTAL
        repoPanel.add(repoRootField, gbc)
        repoPanel.border = BorderFactory.createEmptyBorder(4, 4, 0, 4)

        val tabs = JTabbedPane()
        tabs.addTab("Agent", buildAgentTab())
        tabs.addTab("Services", buildServicesTab())

        root.add(repoPanel, BorderLayout.NORTH)
        root.add(tabs, BorderLayout.CENTER)
    }

    private fun buildAgentTab(): JPanel {
        val tab = JPanel(BorderLayout(4, 4))
        tab.border = BorderFactory.createEmptyBorder(6, 6, 6, 6)

        val topBar = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        topBar.add(JLabel("Agent:"))
        agentCombo.preferredSize = Dimension(260, agentCombo.preferredSize.height)
        topBar.add(agentCombo)
        topBar.add(createButton("Refresh") { refreshAgents() })
        topBar.add(createButton("Clear Chat") { clearConversation() })

        promptArea.lineWrap = true
        promptArea.wrapStyleWord = true
        promptArea.font = Font(Font.MONOSPACED, Font.PLAIN, 12)
        promptArea.border = BorderFactory.createTitledBorder("Prompt (Enter = send, Shift+Enter = newline)")
        promptArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    submitPrompt()
                }
            }
        })
        val promptScroll = JScrollPane(promptArea)
        promptScroll.preferredSize = Dimension(0, 110)

        val runBtn = JButton("Run Agent")
        val stopBtn = JButton("Stop").also { it.isEnabled = false }
        runBtn.addActionListener { submitPrompt(runBtn, stopBtn) }
        stopBtn.addActionListener {
            runThread?.interrupt()
            stopBtn.isEnabled = false
            runBtn.isEnabled = true
            agentStatus.text = "Stopped"
        }

        val btnBar = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        btnBar.add(runBtn)
        btnBar.add(stopBtn)
        btnBar.add(Box.createHorizontalStrut(12))
        btnBar.add(agentStatus)

        responsePane.contentType = "text/html"
        responsePane.isEditable = false
        responsePane.background = Color(30, 30, 30)
        val kit = HTMLEditorKit()
        responsePane.editorKit = kit
        responsePane.document = kit.createDefaultDocument()
        appendHtml("<p style='color:#888;font-family:sans-serif;font-size:12px;padding:8px;'>No conversation yet. Select an agent and type a prompt.</p>")

        val responseScroll = JScrollPane(responsePane)

        val inputPanel = JPanel(BorderLayout(4, 4))
        inputPanel.add(promptScroll, BorderLayout.CENTER)
        inputPanel.add(btnBar, BorderLayout.SOUTH)

        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, responseScroll, inputPanel)
        split.resizeWeight = 0.75
        split.isContinuousLayout = true

        tab.add(topBar, BorderLayout.NORTH)
        tab.add(split, BorderLayout.CENTER)

        ApplicationManager.getApplication().executeOnPooledThread { refreshAgents() }
        return tab
    }

    private fun submitPrompt(runBtn: JButton? = null, stopBtn: JButton? = null) {
        val prompt = promptArea.text.trim()
        if (prompt.isEmpty()) {
            agentStatus.text = "Enter a prompt first"
            return
        }

        runBtn?.isEnabled = false
        stopBtn?.isEnabled = true
        agentStatus.text = "Running..."

        val selectedAgent = selectedAgent()
        val systemPrompt = selectedAgent?.systemPrompt
            ?: "You are a senior engineering agent. Be practical and detailed about changes."

        val history = conversation.toList()
        conversation.add(ConversationTurn("user", prompt))
        appendHtml(userBubble(prompt))
        promptArea.text = ""

        runThread = Thread {
            try {
                val rootPath = resolvedRepoRoot() ?: throw IllegalStateException("Repo root is not set")
                val envFile = File(rootPath, ".env")
                if (!envFile.exists()) {
                    throw IllegalStateException(".env not found at ${envFile.absolutePath}")
                }
                val env = EnvReader.read(rootPath)
                if (env["APIGEE_ENDPOINT"].isNullOrBlank()) {
                    throw IllegalStateException("APIGEE_ENDPOINT not set in .env (${envFile.absolutePath})")
                }
                SwingUtilities.invokeLater { agentStatus.text = "Calling Gemini..." }
                val response = GeminiClient(env).callGemini(
                    systemPrompt,
                    history + listOf(ConversationTurn("user", prompt)),
                )
                conversation.add(ConversationTurn("model", response))
                appendHtml(assistantBubble(selectedAgent?.name ?: "Agent", response))
                SwingUtilities.invokeLater { agentStatus.text = "Done" }
            } catch (e: InterruptedException) {
                SwingUtilities.invokeLater { agentStatus.text = "Stopped" }
            } catch (e: Exception) {
                appendHtml(errorBubble(e.message ?: "Unknown error"))
                val detail = (e.message ?: "Unknown error")
                SwingUtilities.invokeLater {
                    val shortDetail = if (detail.length > 120) detail.substring(0, 120) + "..." else detail
                    agentStatus.text = "Failed: $shortDetail"
                }
            } finally {
                SwingUtilities.invokeLater {
                    runBtn?.isEnabled = true
                    stopBtn?.isEnabled = false
                }
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun refreshAgents() {
        val rootPath = resolvedRepoRoot() ?: return
        val found = try {
            AgentDiscovery.discover(rootPath)
        } catch (e: Exception) {
            SwingUtilities.invokeLater { agentStatus.text = "Failed to load agents: ${e.message}" }
            emptyList()
        }

        SwingUtilities.invokeLater {
            agents.clear()
            agents.addAll(found)
            val model = DefaultComboBoxModel<String>()
            if (found.isEmpty()) {
                model.addElement("(no agents found)")
            } else {
                found.forEach { model.addElement(it.name) }
            }
            agentCombo.model = model
            agentStatus.text = if (found.isEmpty()) "No agent files found" else "${found.size} agent(s) loaded"
        }
    }

    private fun scheduleAgentRefresh() {
        ApplicationManager.getApplication().executeOnPooledThread {
            refreshAgents()
        }
    }

    private fun clearConversation() {
        conversation.clear()
        try {
            val doc = responsePane.document
            doc.remove(0, doc.length)
        } catch (_: Exception) {
        }
        appendHtml("<p style='color:#888;font-family:sans-serif;font-size:12px;padding:8px;'>Conversation cleared.</p>")
        promptArea.text = ""
        agentStatus.text = "Ready"
    }

    private fun selectedAgent(): AgentDefinition? {
        val idx = agentCombo.selectedIndex
        return if (idx >= 0 && idx < agents.size) agents[idx] else null
    }

    private fun userBubble(text: String): String {
        return "<div style='margin:6px 2px;padding:8px 10px;background:#1a3a5c;border-left:3px solid #4a9eda;border-radius:4px;font-family:sans-serif;font-size:13px;color:#d4d4d4;'><strong style='color:#4a9eda;'>You</strong><br/>${MarkdownRenderer.toHtml(text)}</div>"
    }

    private fun assistantBubble(name: String, text: String): String {
        return "<div style='margin:6px 2px;padding:8px 10px;background:#1a2e1a;border-left:3px solid #6aaa6a;border-radius:4px;font-family:sans-serif;font-size:13px;color:#d4d4d4;'><strong style='color:#6aaa6a;'>$name</strong><br/>${MarkdownRenderer.toHtml(text)}</div>"
    }

    private fun errorBubble(message: String): String {
        return "<div style='margin:6px 2px;padding:8px 10px;background:#3a1a1a;border-left:3px solid #cc4444;border-radius:4px;font-family:sans-serif;font-size:13px;color:#d4d4d4;'><strong style='color:#cc4444;'>Error</strong><br/>${MarkdownRenderer.toHtml(message)}</div>"
    }

    private fun appendHtml(html: String) {
        SwingUtilities.invokeLater {
            try {
                val kit = responsePane.editorKit as HTMLEditorKit
                val doc = responsePane.document as HTMLDocument
                val safeHtml = sanitizeHtmlForSwing(html)
                kit.insertHTML(doc, doc.length, safeHtml, 0, 0, null)
                responsePane.caretPosition = doc.length
            } catch (_: Exception) {
                try {
                    val doc = responsePane.document
                    val fallback = html
                        .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
                        .replace(Regex("</p>", RegexOption.IGNORE_CASE), "\n")
                        .replace(Regex("<[^>]+>"), "")
                    doc.insertString(doc.length, fallback + "\n", null)
                    responsePane.caretPosition = doc.length
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun sanitizeHtmlForSwing(html: String): String {
        return html
            .replace(Regex("\\sstyle='[^']*'", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\sstyle=\"[^\"]*\"", RegexOption.IGNORE_CASE), "")
    }

    private fun buildServicesTab(): JPanel {
        servicesOutput.isEditable = false
        servicesOutput.lineWrap = true
        servicesOutput.wrapStyleWord = true
        servicesOutput.font = Font(Font.MONOSPACED, Font.PLAIN, 12)

        val buttonBar = JPanel(FlowLayout(FlowLayout.LEFT))
        buttonBar.add(createButton("One Click Deploy") { runScript("deploy-intellij.ps1") })
        buttonBar.add(createButton("Start Core Services (No Ollama)") { runScript("scripts/intellij/start-services.ps1", "-ServiceProfile", "core") })
        buttonBar.add(createButton("Build RAG Index") { runScript("scripts/intellij/build-rag-index.ps1") })
        buttonBar.add(createButton("Start Core + Index") { runScript("scripts/intellij/start-core-and-index.ps1") })
        buttonBar.add(createButton("Clear Log") {
            servicesOutput.text = ""
            servicesStatus.text = "Cleared"
        })

        val top = JPanel(BorderLayout())
        top.add(buttonBar, BorderLayout.CENTER)
        top.add(servicesStatus, BorderLayout.SOUTH)

        val tab = JPanel(BorderLayout())
        tab.border = BorderFactory.createEmptyBorder(4, 6, 6, 6)
        tab.add(top, BorderLayout.NORTH)
        tab.add(JScrollPane(servicesOutput), BorderLayout.CENTER)
        return tab
    }

    private fun runScript(relativePath: String, vararg args: String) {
        val basePath = resolvedRepoRoot()
        if (basePath.isNullOrBlank()) {
            appendServiceLine("[ERROR] Repo root is not set")
            return
        }

        val scriptPath = Path.of(basePath, relativePath)
        if (!Files.exists(scriptPath)) {
            appendServiceLine("[ERROR] Script not found: $scriptPath")
            return
        }

        servicesStatus.text = "Running: $relativePath"
        appendServiceLine("[INFO] Running ${scriptPath.fileName} ${args.joinToString(" ")}")

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val shell = if (SystemInfo.isWindows) "powershell" else "pwsh"
                val command = mutableListOf(shell, "-ExecutionPolicy", "Bypass", "-File", scriptPath.toString())
                command.addAll(args)
                val cmd = GeneralCommandLine(command).withWorkDirectory(basePath)
                cmd.environment["REPO_ROOT"] = basePath

                val handler = OSProcessHandler(cmd)
                handler.addProcessListener(object : ProcessAdapter() {
                    override fun onTextAvailable(event: ProcessEvent, outputType: com.intellij.openapi.util.Key<*>) {
                        val text = event.text.trimEnd()
                        if (text.isEmpty()) return
                        appendServiceLine(if (outputType === ProcessOutputTypes.STDERR) "[ERROR] $text" else "[INFO] $text")
                    }

                    override fun processTerminated(event: ProcessEvent) {
                        SwingUtilities.invokeLater {
                            servicesStatus.text = if (event.exitCode == 0) {
                                "Completed: $relativePath"
                            } else {
                                "Failed (${event.exitCode}): $relativePath"
                            }
                        }
                    }
                })
                handler.startNotify()
            } catch (ex: Exception) {
                appendServiceLine("[ERROR] ${ex.message}")
                SwingUtilities.invokeLater { servicesStatus.text = "Execution failed" }
            }
        }
    }

    private fun appendServiceLine(line: String) {
        SwingUtilities.invokeLater {
            servicesOutput.append(line)
            servicesOutput.append("\n")
            servicesOutput.caretPosition = servicesOutput.document.length
        }
    }

    private fun createButton(label: String, action: () -> Unit): JButton {
        val button = JButton(label)
        button.addActionListener { action() }
        return button
    }

    private fun resolvedRepoRoot(): String? {
        val text = repoRootField.text.trim()
        return if (text.isNotBlank()) text else null
    }

    private fun detectRepoRoot(startPath: String?): String? {
        if (startPath.isNullOrBlank()) return null
        var current = Path.of(startPath)
        repeat(8) {
            if (Files.exists(current.resolve("deploy-intellij.ps1"))) return current.toString()
            val parent = current.parent ?: return null
            current = parent
        }
        return null
    }
}
