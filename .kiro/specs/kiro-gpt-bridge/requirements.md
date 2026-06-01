# Requirements Document

## Introduction

The KIRO-GPT Bridge integrates ChatGPT Pro and DALL-E image generation directly into the KIRO IDE through a three-component architecture: a KIRO Extension (TypeScript) that provides the in-IDE UI, a Relay Server (Node.js, Express, Socket.IO) that routes messages between clients and agents, and a Browser Agent (Puppeteer-extra with Stealth) that drives a real Chrome instance against the ChatGPT Pro web UI. The system leverages the user's existing ChatGPT Pro subscription via the web UI rather than the official API.

The architecture supports multiple KIRO clients and multiple Browser Agents in parallel. The Relay Server dispatches each incoming request directly to an idle agent when one is available and only enqueues the request when all agents are busy. Responses (text streams or base64-encoded images) are streamed back to the originating KIRO client. The system is designed for resilience: every layer reconnects automatically, in-flight requests can be cancelled from the UI, and authentication is enforced via shared secrets between layers.

This document specifies the requirements for the Relay Server, Browser Agent, KIRO Extension, code-context features, image generation, authentication, reliability, dispatch-versus-queue logic, observability, and correctness properties suitable for property-based testing.

## Glossary

- **KIRO_IDE**: The KIRO desktop IDE in which the user works.
- **KIRO_Extension**: The TypeScript VS Code-style extension that runs inside the KIRO_IDE and exposes the ChatGPT panel and commands.
- **Relay_Server**: The Node.js Express + Socket.IO server that routes messages between KIRO_Extension instances and Browser_Agent instances.
- **Browser_Agent**: The Node.js Puppeteer-extra process that controls a real Chrome instance with a persistent user profile and drives the ChatGPT Pro web UI.
- **ChatGPT_Pro**: The ChatGPT Pro web application at chat.openai.com (or successor URL) accessed via the user's logged-in session.
- **DALLE**: The DALL-E image generation feature exposed through ChatGPT_Pro.
- **KIRO_Client**: A connected instance of the KIRO_Extension as registered on the Relay_Server.
- **Agent**: Synonym for Browser_Agent as registered on the Relay_Server.
- **Request**: A user-initiated message routed from a KIRO_Client through the Relay_Server to an Agent, of type "chat" or "image".
- **Response**: The streamed reply from the Agent back to the originating KIRO_Client, consisting of text chunks or a base64-encoded image.
- **Dispatcher**: The Relay_Server component that selects an Agent for a Request and decides between immediate dispatch and enqueueing.
- **Pending_Queue**: The FIFO queue of Requests held by the Relay_Server when no idle Agent is available.
- **Idle_Agent**: A registered Agent that is currently not processing any Request.
- **Busy_Agent**: A registered Agent that is currently processing a Request.
- **Session**: A logical conversation thread maintained by a KIRO_Client, identified by a session ID, that preserves message history.
- **KIRO_Secret**: The shared secret presented by KIRO_Extension instances to authenticate with the Relay_Server.
- **Agent_Secret**: The shared secret presented by Browser_Agent instances to authenticate with the Relay_Server.
- **Code_Context**: Structured metadata sent with a Request describing the user's selected text, active file path, language, and optionally referenced files or folders.
- **Stream_Chunk**: A partial Response payload (typically one or more words of text) emitted incrementally during streaming.
- **Cancel_Signal**: A control message from a KIRO_Client instructing the Relay_Server to abort an in-flight Request.

## Requirements

### Requirement 1: Relay Server Lifecycle and Configuration

**User Story:** As a developer running the bridge locally, I want a Relay Server that starts on a configurable port and accepts large messages, so that text and image responses can flow reliably between extension and agent.

#### Acceptance Criteria

1. WHEN the Relay_Server is started, THE Relay_Server SHALL listen on TCP port 3001 by default and SHALL allow the port to be overridden by the environment variable PORT, where PORT is an integer between 1 and 65535.
2. IF the environment variable PORT is set to a value outside the integer range 1 to 65535 or to a non-integer value, THEN THE Relay_Server SHALL log a structured error identifying the invalid value and SHALL exit with a non-zero status code.
3. THE Relay_Server SHALL accept Socket.IO messages with a maximum payload size of 100 megabytes.
4. IF the Relay_Server receives a Socket.IO message exceeding 100 megabytes, THEN THE Relay_Server SHALL reject the message with an error code of PAYLOAD_TOO_LARGE and SHALL log the rejection with the originating socket ID and message size.
5. WHEN the Relay_Server receives a SIGTERM or SIGINT signal, THE Relay_Server SHALL stop accepting new connections and SHALL allow in-flight Responses up to 30 seconds to complete before exiting.
6. IF in-flight Responses do not complete within 30 seconds of receiving SIGTERM or SIGINT, THEN THE Relay_Server SHALL terminate those Responses, SHALL emit a failure Response with error code SHUTDOWN to each affected KIRO_Client, and SHALL exit.
7. WHEN the Relay_Server starts, THE Relay_Server SHALL expose an HTTP GET /health endpoint that returns HTTP status 200 with a JSON body containing the fields status, uptimeSeconds, registeredAgents, registeredClients, and queueDepth.
8. IF the Relay_Server cannot bind to the configured port, THEN THE Relay_Server SHALL log a structured error containing the port number and the bind failure reason and SHALL exit with a non-zero status code.

### Requirement 2: Authentication via Shared Secrets

**User Story:** As an operator, I want every connection to the Relay Server to be authenticated, so that unauthorized clients cannot send requests to my browser agent or impersonate it.

#### Acceptance Criteria

1. WHEN a KIRO_Client connects to the Relay_Server, THE Relay_Server SHALL require the KIRO_Client to present a value matching the KIRO_Secret in the Socket.IO handshake auth payload within 5 seconds of socket establishment.
2. WHEN a Browser_Agent connects to the Relay_Server, THE Relay_Server SHALL explicitly check the handshake auth payload for the presence of an Agent_Secret value within 5 seconds of socket establishment, SHALL compare the presented value against the configured Agent_Secret, and SHALL reject the connection if the value is missing or non-matching.
3. IF a connecting client presents a missing or non-matching secret, or fails to present an auth payload within 5 seconds, THEN THE Relay_Server SHALL reject the connection with a Socket.IO authentication error, SHALL not establish a session, and SHALL log the rejection with the client IP address and an ISO 8601 UTC timestamp.
4. WHERE the environment variable RELAY_TLS_ENABLED equals "true", THE Relay_Server SHALL accept connections only over TLS using the certificate and key paths provided in environment variables RELAY_TLS_CERT and RELAY_TLS_KEY; IF RELAY_TLS_CERT or RELAY_TLS_KEY is empty, missing, unreadable, or contains an invalid certificate or key, THEN THE Relay_Server SHALL log a structured TLS configuration error and SHALL exit with a non-zero status code.
5. THE Relay_Server SHALL load KIRO_Secret and Agent_Secret from environment variables at startup and SHALL refuse to start if either secret is empty, shorter than 16 characters, or longer than 256 characters, exiting with a non-zero status code and logging a structured error identifying which secret is invalid.
6. IF the Relay_Server records 5 or more failed authentication attempts from the same source IP address within a 60-second window, THEN THE Relay_Server SHALL reject further connection attempts from that IP for 300 seconds and SHALL log the lockout with the IP address, attempt count, and timestamp.

### Requirement 3: Agent Registration and Heartbeat

**User Story:** As an operator, I want the relay to track which agents are connected and healthy, so that requests are only dispatched to live agents.

#### Acceptance Criteria

1. WHEN a Browser_Agent successfully authenticates, THE Relay_Server SHALL register the Browser_Agent with an agent ID that is unique among all currently registered agents and SHALL mark the Browser_Agent as Idle_Agent.
2. WHILE a Browser_Agent is registered with the Relay_Server, THE Browser_Agent SHALL emit a heartbeat message to the Relay_Server every 15 seconds with a tolerance of plus or minus 2 seconds.
3. IF the Relay_Server does not receive a heartbeat from a registered Browser_Agent within 45 seconds of the last received heartbeat or, for a newly registered Agent, within 45 seconds of registration, THEN THE Relay_Server SHALL mark the Browser_Agent as disconnected and SHALL remove the Browser_Agent from the dispatch pool.
4. WHILE a Browser_Agent is processing one or more Requests, IF the Browser_Agent disconnects, THEN THE Relay_Server SHALL mark each in-progress Request as failed and SHALL emit, within 5 seconds of detecting the disconnect, a failure Response to each originating KIRO_Client containing an error code of AGENT_DISCONNECTED.
5. WHEN a Browser_Agent reconnects after a disconnect, THE Relay_Server SHALL purge the previous agent ID, SHALL assign the reconnecting Browser_Agent a new agent ID that is unique among all currently registered agents, and SHALL register the Browser_Agent as a fresh Idle_Agent.
6. IF the Relay_Server receives a malformed heartbeat message from a registered Browser_Agent, THEN THE Relay_Server SHALL discard the heartbeat and SHALL NOT update the Browser_Agent's last-heartbeat timestamp.

### Requirement 4: KIRO Client Registration

**User Story:** As a developer, I want my KIRO Extension to register with the relay automatically, so that I can send requests as soon as the extension activates.

#### Acceptance Criteria

1. WHEN the KIRO_Extension activates and the user setting kiroGptBridge.relayUrl contains a non-empty value, THE KIRO_Extension SHALL initiate a connection to that Relay_Server URL within 5 seconds of activation.
2. IF the user setting kiroGptBridge.relayUrl is missing, empty, or not a syntactically valid URL when the KIRO_Extension activates, THEN THE KIRO_Extension SHALL display an error message indicating that the relay URL is not configured and SHALL not attempt to connect.
3. IF a connection attempt to the Relay_Server does not complete within 10 seconds or fails with a transport error, THEN THE KIRO_Extension SHALL retry the connection up to 5 times with at least 2 seconds between attempts before surfacing a connection error to the user.
4. WHEN a KIRO_Client successfully authenticates, THE Relay_Server SHALL assign the KIRO_Client a unique client ID between 16 and 64 characters in length and SHALL associate that client ID with the connecting socket within 1 second of authentication completing.
5. WHEN a KIRO_Client disconnects, THE Relay_Server SHALL, within 2 seconds, cancel every in-flight Request originated by that KIRO_Client by sending a Cancel_Signal to each assigned Agent.
6. THE Relay_Server SHALL support at least 50 concurrently registered KIRO_Client instances without rejecting new registrations or degrading registration latency beyond 1 second.
7. IF the Relay_Server has already reached its concurrent registration capacity of 50 KIRO_Client instances when a new registration is attempted, THEN THE Relay_Server SHALL reject the registration with an error indicating that client capacity has been exceeded and SHALL leave existing registrations unchanged.

### Requirement 5: Smart Dispatch When Agents Are Available

**User Story:** As a user, I want my requests to be sent to an idle agent immediately when one is available, so that I do not experience unnecessary queuing delay.

#### Acceptance Criteria

1. WHEN the Relay_Server receives a Request and at least one Idle_Agent exists, THE Dispatcher SHALL select an Idle_Agent and SHALL forward the Request to the selected Agent within 100 milliseconds without inserting the Request into the Pending_Queue.
2. THE Dispatcher SHALL select among Idle_Agent instances only, using a least-busy strategy where workload is defined as the count of Requests dispatched to that Agent in the preceding 60 seconds, and SHALL break ties by round-robin order based on the timestamp of the Agent's most recent Request completion; IF a tied Idle_Agent has no completion history, THEN that Agent SHALL be treated as having the oldest possible completion timestamp for tie-breaking purposes.
3. WHEN the Dispatcher forwards a Request to an Agent, THE Relay_Server SHALL mark the Agent as Busy_Agent and SHALL record the Request ID, originating KIRO_Client ID, and dispatch timestamp in that order before issuing any further dispatch operations.
4. WHILE at least one Idle_Agent exists, THE Dispatcher SHALL forward newly received Requests directly to an Idle_Agent and SHALL NOT enqueue any newly received Request, evaluating Idle_Agent availability before any queue operation.
5. WHEN the Agent acknowledges receipt of a directly-dispatched Request, THE Relay_Server SHALL emit within 200 milliseconds a status event to the originating KIRO_Client with status equal to "dispatched" and SHALL include the assigned agent ID.
6. IF forwarding a Request to a selected Agent fails with a transport error, THEN THE Dispatcher SHALL retry forwarding to a different Idle_Agent up to 3 times before falling back to enqueuing the Request and emitting a status event with status equal to "dispatch_retrying" containing the retry count.
7. IF retries are exhausted for a Request and no Idle_Agent remains, THEN THE Dispatcher SHALL enqueue the Request to the Pending_Queue and SHALL emit a status event to the originating KIRO_Client with status equal to "queued_after_dispatch_failure".
8. IF a directly-dispatched Request is not acknowledged by the assigned Agent within 5 seconds, THEN THE Dispatcher SHALL mark the Agent as unhealthy, restore the Request to the head of the Pending_Queue, and emit a status event with status equal to "redispatching".

### Requirement 6: Queueing When All Agents Are Busy

**User Story:** As a user, I want my request to be held and processed in order when all agents are busy, so that no request is dropped under load.

#### Acceptance Criteria

1. WHEN the Relay_Server receives a Request and zero Idle_Agent instances exist, THE Dispatcher SHALL append the Request to the tail of the Pending_Queue within 50 milliseconds.
2. WHEN a Request is enqueued, THE Relay_Server SHALL emit a status event within 200 milliseconds to the originating KIRO_Client with status equal to "queued" and SHALL include the current queue position of the Request.
3. WHEN an Agent transitions from Busy_Agent to Idle_Agent and the Pending_Queue is non-empty, THE Dispatcher SHALL remove the Request at the head of the Pending_Queue and SHALL forward that Request to the now-idle Agent regardless of the current Pending_Queue depth.
4. THE Pending_Queue SHALL preserve first-in-first-out ordering of Requests across all dispatch operations.
5. THE Relay_Server SHALL support a Pending_Queue maximum depth that defaults to 1000 Requests and is configurable via the environment variable QUEUE_MAX_DEPTH between 100 and 100000.
6. IF the Pending_Queue depth equals the configured QUEUE_MAX_DEPTH when a new Request arrives, THEN THE Relay_Server SHALL reject the new incoming Request with an error code of QUEUE_FULL and SHALL emit the error to the originating KIRO_Client within 200 milliseconds.
7. WHEN a queued Request remains in the Pending_Queue for longer than 600 seconds, THE Relay_Server SHALL remove the Request from the Pending_Queue and SHALL emit a failure Response to the originating KIRO_Client with an error code of QUEUE_TIMEOUT.
8. WHEN a KIRO_Client disconnects while one or more of its Requests are in the Pending_Queue, THE Relay_Server SHALL remove those Requests from the Pending_Queue and SHALL NOT dispatch them.

### Requirement 7: Dispatcher Correctness Properties

**User Story:** As a system designer, I want strong invariants on the dispatcher, so that no message is lost, ordering is preserved, and busy-state tracking is consistent.

#### Acceptance Criteria

1. THE Dispatcher SHALL maintain the invariant that at any point in time, the count of Busy_Agent instances plus the count of Idle_Agent instances equals the count of Agents that are currently registered and not marked as disconnected.
2. THE Dispatcher SHALL maintain the invariant that for every Request received and acknowledged by the Relay_Server, the Request is in exactly one of the following states: dispatched-and-in-flight, queued, completed, cancelled, failed, or queue-timeout.
3. WHEN a sequence of Requests R1, R2, ..., Rn is enqueued while all Agents are busy and no further Requests arrive, THE Dispatcher SHALL forward those Requests to Agents in the same R1, R2, ..., Rn order as Agents become idle; IF multiple Agents become idle simultaneously, THEN the Dispatcher SHALL still pop Requests from the head of the Pending_Queue in arrival order before forwarding to the now-idle Agents.
4. THE Dispatcher SHALL maintain the invariant that no single Request is concurrently dispatched to more than one Agent at the same point in time.
5. THE Dispatcher SHALL maintain the invariant that for any single Request, no Response derived from that Request is delivered to more than one KIRO_Client at any point in time.
6. WHEN the Relay_Server acknowledges receipt of a Request, THE Relay_Server SHALL guarantee that the Request will reach a terminal state of completed, cancelled, failed, or queue-timeout, and SHALL NOT silently drop the Request.
7. WHILE a Request is in the Pending_Queue, THE Dispatcher SHALL enforce the queue-timeout terminal state by transitioning the Request to "queue-timeout" if its time-in-queue exceeds 600 seconds, and SHALL emit a corresponding failure Response to the originating KIRO_Client.
8. IF an Agent assigned to a Request fails or disconnects before producing a final Response, THEN the Dispatcher SHALL re-dispatch the Request to another Idle_Agent up to a maximum of 3 attempts in total, after which the Dispatcher SHALL transition the Request to the failed terminal state.

### Requirement 8: Browser Agent Browser Lifecycle

**User Story:** As a user, I want the browser agent to launch a persistent Chrome session so that my ChatGPT Pro login survives restarts.

#### Acceptance Criteria

1. WHEN the Browser_Agent starts, THE Browser_Agent SHALL launch a Chromium instance using puppeteer-extra with the stealth plugin enabled within 30 seconds.
2. THE Browser_Agent SHALL launch the Chromium instance with the headless option set to false.
3. WHEN the Browser_Agent starts, THE Browser_Agent SHALL launch the Chromium instance using a persistent user data directory whose absolute path is read from the environment variable AGENT_PROFILE_DIR.
4. IF the environment variable AGENT_PROFILE_DIR is missing, empty, not an absolute path, or points to a non-writable location, THEN THE Browser_Agent SHALL log a structured error identifying the invalid value and SHALL exit with a non-zero status code.
5. IF the Chromium launch fails for any reason within the 30-second window, THEN THE Browser_Agent SHALL retry the launch up to 3 times with a 5-second delay between attempts before exiting with a non-zero status code.
6. WHEN the Browser_Agent navigates to ChatGPT_Pro and detects that the session is not logged in while no Request is currently being processed, THE Browser_Agent SHALL emit a status event to the Relay_Server with status equal to "login_required" within 2 seconds and SHALL pause Request processing.
7. WHEN the Browser_Agent detects an unauthenticated session while a Request is currently being processed, THE Browser_Agent SHALL complete the current Request, then SHALL emit a status event with status equal to "login_required" within 2 seconds and SHALL pause further Request processing.
8. WHILE the Browser_Agent is paused awaiting login, THE Browser_Agent SHALL re-check the authenticated state of ChatGPT_Pro every 10 seconds.
9. WHEN the user completes the manual login in the launched Chromium instance and the Browser_Agent has confirmed the authenticated state through a successful authentication detection check, THE Browser_Agent SHALL emit a status event with status equal to "ready" within 2 seconds and SHALL resume Request processing.
10. THE Browser_Agent SHALL run on Windows, macOS, and Linux operating systems.

### Requirement 9: Browser Agent Chat Query Handling

**User Story:** As a user, I want my chat questions to be typed into ChatGPT and the response streamed back, so that I get conversational answers in the IDE.

#### Acceptance Criteria

1. WHEN the Browser_Agent receives a Request with type equal to "chat" and a prompt text of length 1 to 32000 characters, THE Browser_Agent SHALL focus the ChatGPT_Pro input field, SHALL clear any existing text, and SHALL type the prompt text from the Request.
2. WHILE the Browser_Agent is typing prompt characters into the ChatGPT_Pro input field, THE Browser_Agent SHALL apply an inter-keystroke delay drawn from a uniform distribution between 20 milliseconds and 80 milliseconds.
3. WHEN the prompt has been fully typed, THE Browser_Agent SHALL submit the prompt by triggering the ChatGPT_Pro send action within 500 milliseconds.
4. WHILE ChatGPT_Pro is generating a Response, THE Browser_Agent SHALL emit Stream_Chunk events to the Relay_Server containing newly produced text segments at intervals not exceeding 250 milliseconds.
5. WHEN ChatGPT_Pro signals that Response generation is complete, THE Browser_Agent SHALL emit within 500 milliseconds a final Stream_Chunk event with isFinal set to true and SHALL include the full assembled text.
6. IF ChatGPT_Pro returns a visible error message in the conversation, THEN THE Browser_Agent SHALL emit within 500 milliseconds a failure Response to the Relay_Server with an error code of CHATGPT_ERROR and SHALL include the visible error text.
7. IF the Browser_Agent cannot focus the ChatGPT_Pro input field within 5 seconds of receiving a chat Request, THEN THE Browser_Agent SHALL emit a failure Response with error code INPUT_UNAVAILABLE and SHALL release the Request.
8. IF ChatGPT_Pro does not produce any visible Stream_Chunk content within 120 seconds of submission, THEN THE Browser_Agent SHALL emit a failure Response with error code CHAT_TIMEOUT.

### Requirement 10: Browser Agent Image Query Handling

**User Story:** As a user, I want to request DALL-E images from the IDE, so that I can generate and use images in my projects.

#### Acceptance Criteria

1. WHEN the Browser_Agent receives a Request with type equal to "image" and a prompt of length 1 to 4000 characters, THE Browser_Agent SHALL submit the prompt to ChatGPT_Pro within 5 seconds with instructions that invoke DALLE image generation.
2. WHEN DALLE produces an image, THE Browser_Agent SHALL extract the image data from the rendered Response.
3. WHEN image data has been extracted, THE Browser_Agent SHALL encode the image as a base64 string.
4. WHEN the base64 encoding completes, THE Browser_Agent SHALL emit the encoded image as a Response to the Relay_Server with mediaType equal to the image MIME type and isFinal set to true.
5. IF DALLE fails to produce an image within 180 seconds of submission, THEN THE Browser_Agent SHALL emit a failure Response with error code IMAGE_TIMEOUT and isFinal set to true, and SHALL preserve the persistent Chromium session state.
6. IF DALLE refuses the prompt due to content policy, THEN THE Browser_Agent SHALL emit a failure Response with error code CONTENT_POLICY, isFinal set to true, and SHALL include the refusal text returned by DALLE as the policy message.
7. IF the Request prompt is empty, exclusively whitespace, or exceeds 4000 characters, THEN THE Browser_Agent SHALL emit a failure Response with error code INVALID_PROMPT and SHALL not submit anything to ChatGPT_Pro.
8. IF ChatGPT_Pro is unreachable, the session has expired, or the page fails to load when an image Request is received, THEN THE Browser_Agent SHALL emit a failure Response with error code CHATGPT_UNAVAILABLE and isFinal set to true.

### Requirement 11: Browser Agent Reconnection

**User Story:** As a user, I want the browser agent to recover from network drops automatically, so that I do not need to restart it manually.

#### Acceptance Criteria

1. IF the Browser_Agent loses its Socket.IO connection to the Relay_Server, THEN THE Browser_Agent SHALL attempt to reconnect using exponential backoff starting at 1 second, doubling the delay after each failed attempt, capped at 30 seconds between attempts, and SHALL continue retrying until reconnection succeeds or the agent process is stopped.
2. WHEN the Browser_Agent reconnects to the Relay_Server, THE Browser_Agent SHALL complete re-authentication with the Agent_Secret within 10 seconds and SHALL emit a status event whose readiness value is one of "ready", "restarting", or "disconnected".
3. WHILE the Browser_Agent is disconnected from the Relay_Server, THE Browser_Agent SHALL reject new Requests from any source and SHALL respond to each rejected Request with an error indicating that the agent is currently disconnected.
4. IF the Browser_Agent's Chromium instance crashes, THEN THE Browser_Agent SHALL transition its internal state to "restarting", emit a status event of "restarting", and relaunch Chromium using the same persistent profile directory within 30 seconds.
5. WHEN the Browser_Agent detects successful user login within 60 seconds after a Chromium relaunch, THE Browser_Agent SHALL transition its internal state to "ready" and emit a status event of "ready".
6. IF re-authentication with the Agent_Secret fails after reconnection, THEN THE Browser_Agent SHALL close the Socket.IO connection, emit a status event indicating authentication failure, and resume the exponential backoff reconnection sequence defined in criterion 1.
7. IF login detection does not complete within 60 seconds after a Chromium relaunch, THEN THE Browser_Agent SHALL emit a status event indicating restart failure and SHALL retry the Chromium relaunch up to 3 additional times before remaining in the "restarting" state.

### Requirement 12: KIRO Extension Panel and Commands

**User Story:** As a developer, I want a sidebar panel and commands in KIRO so that I can interact with ChatGPT without leaving the IDE.

#### Acceptance Criteria

1. WHEN the KIRO_Extension activates within the KIRO_IDE, THE KIRO_Extension SHALL register a webview panel with the title "ChatGPT Bridge" in the KIRO_IDE sidebar within 3 seconds of activation.
2. WHEN the command kiroGptBridge.openPanel is invoked, THE KIRO_Extension SHALL display the "ChatGPT Bridge" webview panel and set keyboard focus to it within 1 second.
3. IF the command kiroGptBridge.openPanel is invoked while the "ChatGPT Bridge" panel is already visible, THEN THE KIRO_Extension SHALL bring the existing panel into focus without creating a duplicate panel.
4. WHEN the command kiroGptBridge.explainCode is invoked from the editor right-click context menu with a non-empty text selection of 1 to 10000 characters, THE KIRO_Extension SHALL submit the selected text as an explanation Request to the Relay_Server and display the "ChatGPT Bridge" panel within 1 second.
5. IF the command kiroGptBridge.explainCode is invoked with no text selection or with a selection exceeding 10000 characters, THEN THE KIRO_Extension SHALL display an error message indicating the selection is empty or exceeds the maximum allowed length, and SHALL NOT submit a Request to the Relay_Server.
6. WHEN the command kiroGptBridge.generateImage is invoked, THE KIRO_Extension SHALL prompt the user for an image description of 1 to 1000 characters and, upon user confirmation of a non-empty description, submit an image Request containing that description to the Relay_Server within 1 second.
7. IF the user cancels the image description prompt or confirms an empty or whitespace-only description, THEN THE KIRO_Extension SHALL abort the kiroGptBridge.generateImage command without submitting a Request to the Relay_Server.
8. WHEN a Relay_Server status event is received by the KIRO_Extension, THE KIRO_Extension SHALL update the registered status bar item within 500 milliseconds to display exactly one of the values "disconnected", "connected", "streaming", "queued: N" where N is an integer from 0 to 9999, or "agents: M" where M is an integer from 0 to 999.

### Requirement 13: Code-Aware Right-Click Actions

**User Story:** As a developer, I want right-click actions for common code tasks, so that I can ask ChatGPT to operate on selected code with one click.

#### Acceptance Criteria

1. WHEN the KIRO_Extension activates, THE KIRO_Extension SHALL register the following editor context menu commands: kiroGptBridge.explainCode, kiroGptBridge.refactorCode, kiroGptBridge.generateTests, kiroGptBridge.documentCode, kiroGptBridge.findBugs, and kiroGptBridge.optimizeCode.
2. THE KIRO_Extension SHALL show each registered code-aware command in the editor right-click context menu when there is an active text selection of 1 to 100000 characters in length.
3. WHEN the user invokes any code-aware command, THE KIRO_Extension SHALL include the selected text, the active file path, and the file language in the Code_Context of the Request.
4. IF the active file path or the file language cannot be determined, THEN THE KIRO_Extension SHALL block the command, SHALL NOT send the Request, and SHALL display an error message in the panel indicating which context fields are missing.
5. WHEN the user invokes a code-aware command without an active text selection, THE KIRO_Extension SHALL include the entire active file content (up to a maximum of 200000 characters) in the Code_Context.
6. WHEN the KIRO_Extension renders a streamed Response in the webview panel, THE KIRO_Extension SHALL provide a "Copy" button and an "Insert at cursor" button for each fenced code block detected in the Response.
7. WHEN the user clicks "Copy" on a code block, THE KIRO_Extension SHALL write the code block contents to the system clipboard and display a transient confirmation message.
8. IF the user clicks "Insert at cursor" while no editor is active, THEN THE KIRO_Extension SHALL display an error message indicating that an active editor is required and SHALL NOT modify any file.

### Requirement 14: Code Context Injection

**User Story:** As a developer, I want to reference files and folders by name in my prompts, so that ChatGPT can use my project context.

#### Acceptance Criteria

1. WHEN the user submits panel input containing one or more tokens of the form "#File:<path>", THE KIRO_Extension SHALL replace each "#File:<path>" token with the contents of the referenced file before sending the Request, where the file size does not exceed 200 kilobytes per file.
2. WHEN the user submits panel input containing one or more tokens of the form "#Folder:<path>", THE KIRO_Extension SHALL replace each "#Folder:<path>" token with a recursive listing of file paths under the referenced folder before sending the Request, where the listing does not exceed 1000 files per folder.
3. IF a referenced file or folder does not exist, is outside the current workspace root, exceeds the per-file 200 kilobyte limit, or exceeds the per-folder 1000-file limit, THEN THE KIRO_Extension SHALL display a panel error message identifying the offending token and the specific failure reason, and SHALL NOT send the Request.
4. IF the resolved Code_Context exceeds 200 kilobytes after token expansion, THEN THE KIRO_Extension SHALL truncate the Code_Context to 200 kilobytes and SHALL append a notice to the prompt indicating that truncation occurred and the original size in kilobytes.

### Requirement 15: Conversation Sessions and History

**User Story:** As a developer, I want each panel to remember the ongoing conversation, so that follow-up questions work naturally.

#### Acceptance Criteria

1. WHEN the user opens a new chat thread in the panel, THE KIRO_Extension SHALL create a Session with a session ID that is unique across the local machine and SHALL include the session ID in every Request originated from that thread.
2. WHEN a message is added to a Session, THE KIRO_Extension SHALL persist the updated Session message history to local disk within 2 seconds.
3. WHEN a Request belonging to a Session is sent, THE KIRO_Extension SHALL include the prior message history of that Session in the Request payload up to a configurable maximum.
4. THE configurable maximum number of prior messages included in a Session Request SHALL be set by the user via the user setting kiroGptBridge.sessionHistoryMax to a value between 1 and 200, with a default of 50; IF the prior message history exceeds the configured maximum, THEN the KIRO_Extension SHALL include only the most recent N messages where N equals the configured maximum.
5. THE KIRO_Extension SHALL allow the user to maintain at least 5 concurrent active Session threads in the panel, each with independent message histories.
6. THE KIRO_Extension SHALL provide a UI control labeled "New Session" that creates a new Session.
7. THE KIRO_Extension SHALL provide a UI control to delete an existing Session that, when invoked, displays a confirmation prompt and on confirmation removes both the in-memory and on-disk message history for that Session.
8. IF persisting Session message history to disk fails, THEN THE KIRO_Extension SHALL retain the message history in memory, display a non-blocking error notification to the user identifying the failure, and retry persistence the next time a message is added to that Session.

### Requirement 16: Streaming UI

**User Story:** As a user, I want to see ChatGPT's response appear word by word, so that I get fast feedback and can read along.

#### Acceptance Criteria

1. WHEN the KIRO_Extension receives a Stream_Chunk for an active Request, THE KIRO_Extension SHALL append the chunk text to the corresponding message in the panel within 100 milliseconds of receipt, preserving the order in which chunks were received.
2. THE KIRO_Extension SHALL render fenced code blocks in Responses with syntax highlighting matching the declared language tag.
3. IF a fenced code block has no language tag or an unrecognized language tag, THEN THE KIRO_Extension SHALL render the code block as monospaced plain text without syntax highlighting.
4. WHILE Stream_Chunk events for a Request are arriving and the Response is not marked isFinal, THE KIRO_Extension SHALL display a streaming indicator next to the corresponding message and SHALL hide the action buttons "Copy", "Insert at cursor", and "Save as file" for that message.
5. WHEN a Response is marked isFinal, THE KIRO_Extension SHALL remove the streaming indicator and display the action buttons "Copy", "Insert at cursor", and "Save as file" for the message as visible, enabled controls in the rendered panel.
6. IF a Stream_Chunk sequence terminates without the Response being marked isFinal within 30 seconds of the last received chunk, THEN THE KIRO_Extension SHALL remove the streaming indicator, retain the partial message text, and display an error indication that the stream was interrupted.

### Requirement 17: Image Generation in the Panel

**User Story:** As a user, I want to generate images from the panel and save them into my workspace, so that I can use them in my project.

#### Acceptance Criteria

1. THE KIRO_Extension SHALL provide a mode toggle in the panel with options "Chat" and "Image" that defaults to "Chat" on each new panel session.
2. WHEN the panel mode is "Image" and the user submits a prompt of length 1 to 4000 characters, THE KIRO_Extension SHALL send a Request to the Relay_Server with type equal to "image" within 1 second.
3. IF the panel mode is "Image" and the user submits an empty, whitespace-only, or longer-than-4000-character prompt, THEN THE KIRO_Extension SHALL display an inline validation error and SHALL NOT send the Request.
4. WHEN the KIRO_Extension receives a Response with mediaType matching one of the image MIME types image/png, image/jpeg, image/webp, or image/gif, THE KIRO_Extension SHALL render the image inline in the panel and SHALL display a "Save to workspace" action.
5. WHEN the user invokes "Save to workspace" on an image, THE KIRO_Extension SHALL prompt for a filename of length 1 to 255 characters with a default extension matching the image's MIME type and SHALL write the decoded image bytes to the chosen path under the workspace root.
6. IF the chosen image filename is invalid for the host filesystem, THEN THE KIRO_Extension SHALL display an error indicating the invalid characters and re-prompt for a corrected filename.
7. IF the chosen image path already exists, THEN THE KIRO_Extension SHALL prompt the user to confirm overwrite before writing; on decline the KIRO_Extension SHALL abort without modifying the existing file.
8. IF no workspace folder is open when the user invokes "Save to workspace", THEN THE KIRO_Extension SHALL display an error indicating that a workspace must be open and SHALL NOT write any file.
9. IF the Response carries an error code instead of image data (such as IMAGE_TIMEOUT or CONTENT_POLICY), THEN THE KIRO_Extension SHALL render the error inline in the panel and SHALL NOT display the "Save to workspace" action.

### Requirement 18: File Attachments

**User Story:** As a user, I want to attach an image or document into the panel, so that I can ask ChatGPT to analyze it.

#### Acceptance Criteria

1. WHEN the user drops a file with a supported image extension (.jpg, .jpeg, .png, .gif, .webp) or supported document extension (.pdf, .txt, .md, .docx) onto the panel input area, THE KIRO_Extension SHALL accept the file as a pending attachment.
2. WHEN the user drops a supported file onto the panel and the user submits the Request, THE KIRO_Extension SHALL include the file's base64-encoded content and original filename in the Request payload sent to ChatGPT.
3. IF a dropped file exceeds 25 megabytes, THEN THE KIRO_Extension SHALL reject the attachment, SHALL display an error message stating the 25-megabyte file size limit, and SHALL exclude the rejected file from any subsequent Request payload.
4. WHEN a file is accepted as a pending attachment, THE KIRO_Extension SHALL display a chip showing the original filename together with a remove control that, when activated by the user, removes the attachment from the pending set before the Request is sent.
5. IF the user drops a file whose extension is not in the supported image or document extension set defined in criterion 1, THEN THE KIRO_Extension SHALL reject the attachment and SHALL display an error message indicating that the file type is unsupported.

### Requirement 19: Save Response as Markdown

**User Story:** As a developer, I want to save a ChatGPT response as a markdown file in my workspace, so that I can keep useful notes alongside my code.

#### Acceptance Criteria

1. WHEN the user invokes "Save as file" on a final Response, THE KIRO_Extension SHALL prompt the user for a filename with a default extension of ".md", accept filenames between 1 and 255 characters in length, and reject filenames containing characters invalid for the host filesystem by displaying an error message indicating the invalid input and re-prompting for a corrected filename.
2. WHEN the user confirms a valid filename, THE KIRO_Extension SHALL write the Response text to the chosen path under the workspace root using UTF-8 encoding and SHALL display a confirmation message indicating the saved file location upon successful completion.
3. IF the chosen path already exists, THEN THE KIRO_Extension SHALL prompt the user to confirm overwrite before writing the Response, and SHALL abort the save without modifying the existing file if the user explicitly declines the prompt.
4. IF the overwrite confirmation prompt cannot be displayed or the user dismisses the prompt without choosing, THEN THE KIRO_Extension SHALL save the Response to a uniquely-named file derived from the chosen filename by appending a timestamp suffix in the format "_YYYYMMDD-HHMMSS" before the extension.
5. IF no workspace folder is open when the user invokes "Save as file", THEN THE KIRO_Extension SHALL display an error message indicating that a workspace must be open and abort the save operation without writing any file.
6. IF the file write operation fails due to insufficient permissions, insufficient disk space, or any other I/O error, THEN THE KIRO_Extension SHALL display an error message indicating the failure cause and SHALL not leave a partial file at the target path.

### Requirement 20: Cancel In-Flight Request

**User Story:** As a user, I want to cancel a long-running response, so that I am not stuck waiting for output I no longer want.

#### Acceptance Criteria

1. WHILE a Request has been dispatched and no final Response has been received for it, THE KIRO_Extension SHALL display a "Stop" button in the panel for that message.
2. WHEN the user clicks "Stop" on a Request, THE KIRO_Extension SHALL send exactly one Cancel_Signal to the Relay_Server containing the Request ID and SHALL disable the "Stop" button for that message until the cancellation completes or 30 seconds elapse.
3. WHEN the Relay_Server receives a Cancel_Signal for an in-flight Request, THE Relay_Server SHALL forward the Cancel_Signal to the assigned Agent within 1 second and SHALL transition the Request state to "cancelling".
4. WHEN the Browser_Agent receives a Cancel_Signal for an active Request, THE Browser_Agent SHALL invoke the ChatGPT_Pro stop-generation action within 2 seconds and SHALL emit a final Response with status equal to "cancelled" that includes any partial output accumulated up to the cancellation point.
5. WHEN the Relay_Server receives a Cancel_Signal for a queued Request, THE Relay_Server SHALL remove the Request from the Pending_Queue within 1 second and SHALL emit a final Response with status equal to "cancelled" to the originating KIRO_Client.
6. IF the Relay_Server receives a Cancel_Signal for a Request that is not present in the Pending_Queue and is not currently in-flight, THEN THE Relay_Server SHALL respond with an acknowledgement indicating the Request is not cancellable and SHALL NOT alter any other Request state.
7. IF the Relay_Server cannot deliver a Cancel_Signal to the assigned Agent within 5 seconds, THEN THE Relay_Server SHALL transition the Request to the "failed" terminal state with error code CANCEL_DELIVERY_FAILED and SHALL emit a final Response to the originating KIRO_Client.

### Requirement 21: Extension Reconnection

**User Story:** As a developer, I want the extension to recover the relay connection automatically, so that transient network failures do not require restarting KIRO.

#### Acceptance Criteria

1. IF the KIRO_Extension loses its connection to the Relay_Server, THEN THE KIRO_Extension SHALL attempt reconnection using exponential backoff with the initial delay set to exactly 1 second, doubling the delay after each failed attempt, capped at 30 seconds between attempts, and SHALL continue retrying until reconnection succeeds or the user explicitly cancels reconnection.
2. WHILE the KIRO_Extension is disconnected, THE KIRO_Extension SHALL display the status bar state "disconnected" within 1 second of detecting the disconnection and SHALL disable the Send action in the panel.
3. WHEN the KIRO_Extension reconnects, THE KIRO_Extension SHALL re-register with the Relay_Server and SHALL re-emit every Request that has not yet reached a terminal state of completed, cancelled, failed, or queue-timeout, regardless of any prior "dispatched" or "queued" acknowledgement.
4. WHEN the Relay_Server receives a re-emitted Request whose Request ID matches an existing Request already in the Relay_Server's tracking state, THE Relay_Server SHALL retain the existing Request state, discard the duplicate Request, and SHALL NOT re-dispatch the Request.
5. IF re-registration with the Relay_Server fails after a successful socket reconnection, THEN THE KIRO_Extension SHALL close the socket and resume the exponential backoff reconnection sequence defined in criterion 1.

### Requirement 22: Status Indicators

**User Story:** As a user, I want clear status indicators, so that I know whether my request is connected, dispatched, queued, or streaming.

#### Acceptance Criteria

1. THE KIRO_Extension SHALL render a status indicator in the panel header that displays exactly one of the following labels at any time: "Disconnected", "Connected", "Dispatched", "Streaming", "Queued (position N)" where N is an integer from 1 to the current Pending_Queue depth, or "Cancelled".
2. WHEN the KIRO_Extension is launched and has not yet established a session with the Relay_Server, THE KIRO_Extension SHALL set the panel header status indicator to "Disconnected".
3. THE KIRO_Extension SHALL render a status indicator showing the count of registered Agents (an integer from 0 to the maximum reported by the Relay_Server) and the current Pending_Queue depth (an integer from 0 to the maximum reported by the Relay_Server) using the most recent values received from the Relay_Server.
4. WHEN the Relay_Server emits a status update event affecting the connection state, request lifecycle, registered Agent count, or Pending_Queue depth, THE KIRO_Extension SHALL update each indicator that reflects the changed value within 500 milliseconds of receiving the event.
5. IF the connection to the Relay_Server is lost or no status update has been received for longer than 5 seconds, THEN THE KIRO_Extension SHALL set the panel header status indicator to "Disconnected" and display the registered Agent count and Pending_Queue depth indicators as unavailable.
6. WHEN a Request transitions to the "Cancelled" state, THE KIRO_Extension SHALL display the "Cancelled" label in the panel header for at least 3 seconds before transitioning to the next applicable state label.

### Requirement 23: Login Expiration Handling

**User Story:** As a user, I want to be notified when my ChatGPT login expires, so that I can re-authenticate without losing track of pending requests.

#### Acceptance Criteria

1. WHEN the Browser_Agent observes a login redirect or an authentication-error response from ChatGPT_Pro, THE Browser_Agent SHALL emit within 2 seconds a status event with status equal to "login_required".
2. WHEN the Relay_Server receives a "login_required" status event from an Agent, THE Relay_Server SHALL within 1 second mark that Agent as not available for dispatch.
3. WHILE an Agent is marked as login_required, THE Relay_Server SHALL NOT forward new Requests to that Agent and SHALL preserve any in-flight Request state assigned to that Agent without data loss.
4. WHEN all registered Agents are in "login_required" state, THE Relay_Server SHALL hold all Requests in the Pending_Queue in arrival order and SHALL emit within 1 second a status event with status equal to "login_required" to all KIRO_Client instances.
5. IF a new Request arrives while all registered Agents are in "login_required" state, THEN THE Relay_Server SHALL append the Request to the tail of the Pending_Queue without rejecting it (subject to QUEUE_FULL handling per Requirement 6).
6. WHEN any single Agent transitions from "login_required" to "ready" after the user re-authenticates, THE Relay_Server SHALL within 1 second resume dispatching Requests from the Pending_Queue in FIFO order using that ready Agent without waiting for additional Agents to become ready, and SHALL notify all KIRO_Client instances of the ready transition.

### Requirement 24: Observability and Logging

**User Story:** As an operator, I want structured logs and metrics, so that I can monitor health, latency, and errors.

#### Acceptance Criteria

1. WHEN any Request lifecycle event occurs (received, dispatched, queued, completed, cancelled, or failed), THE Relay_Server SHALL emit a structured JSON log entry within 100 milliseconds of the event.
2. Each Relay_Server log entry SHALL include the required fields timestamp (ISO 8601 UTC with millisecond precision), requestId (non-empty string), clientId (non-empty string), and eventType (non-empty string), and SHALL include agentId (non-empty string or null) and durationMs (non-negative integer or omitted) where applicable.
3. THE durationMs field SHALL be required for events of type completed, cancelled, and failed, and SHALL measure the elapsed milliseconds from Request received to the event being logged.
4. IF emitting a log entry fails (e.g., disk write error or stdout closed), THEN THE Relay_Server SHALL continue processing the Request without aborting and SHALL increment an internal log_failures counter exposed via /metrics.
5. WHEN the Relay_Server is running, THE Relay_Server SHALL expose an HTTP GET /metrics endpoint that responds within 1000 milliseconds in Prometheus text format with: counters for requests_total and requests_failed_total, gauges for queue_depth and agents_connected, and a histogram for request_duration_seconds.
6. WHEN any of the following events occurs in the Browser_Agent — Request received, Stream_Chunk emitted, or error encountered — THE Browser_Agent SHALL emit a structured JSON log entry containing timestamp, requestId, eventType, and (for stream chunks) chunkIndex, and (for errors) errorCategory.

### Requirement 25: Docker Compose Deployment

**User Story:** As an operator, I want to run the relay (and optionally the browser agent) via Docker Compose, so that I can deploy the bridge consistently.

#### Acceptance Criteria

1. THE project SHALL include a docker-compose.yml file that defines a service named relay running the Relay_Server on container port 3001 published to host port 3001.
2. THE docker-compose.yml file SHALL accept the environment variables KIRO_SECRET, AGENT_SECRET, RELAY_TLS_ENABLED, RELAY_TLS_CERT, and RELAY_TLS_KEY for the relay service, with KIRO_SECRET and AGENT_SECRET marked as required.
3. WHERE Docker Compose is used to deploy the relay, THE relay container SHALL include a HEALTHCHECK directive that polls the /health endpoint every 30 seconds with a 5-second timeout and a 3-attempt retry policy.
4. THE Browser_Agent SHALL run on the user's local machine outside Docker by default, because the Browser_Agent requires a non-headless Chromium instance with a persistent user profile.

### Requirement 26: Parser and Serializer Round-Trip

**User Story:** As a developer building this system, I want serialization round-trips to be safe, so that messages, code context, and image payloads are not corrupted across hops.

#### Acceptance Criteria

1. THE Relay_Server SHALL serialize Request and Response objects to UTF-8 encoded JSON conforming to a documented schema with a maximum serialized message size of 25 MB, and SHALL deserialize incoming UTF-8 JSON messages using the same schema.
2. THE Relay_Server SHALL provide a pretty printer that formats Request and Response objects as UTF-8 encoded JSON conforming to the documented schema, using deterministic field ordering and 2-space indentation, such that pretty-printed outputs of two equal objects are byte-for-byte identical.
3. FOR ALL valid Request objects up to 25 MB serialized size, deserializing the pretty printer output SHALL produce an object equal to the original Request, where equality requires every schema field to match exactly, including all nested Code_Context fields and the byte content of every attachment.
4. FOR ALL valid Response objects up to 25 MB serialized size, including those containing base64-encoded image payloads, deserializing the pretty printer output SHALL produce an object whose decoded image bytes are byte-for-byte identical to the original and whose remaining schema fields match the original exactly.
5. IF an incoming message fails schema validation, THEN THE Relay_Server SHALL reject the message with error code SCHEMA_INVALID within 500 milliseconds of receipt, SHALL include in the error response an indication of the first failing field and the validation rule violated, SHALL discard any partial state from the rejected message, and SHALL log the validation error with a timestamp and message identifier.
6. IF an incoming message is not well-formed UTF-8 JSON or exceeds the 25 MB maximum message size, THEN THE Relay_Server SHALL reject the message with an error code indicating malformed input or size limit exceeded, SHALL not attempt schema validation, and SHALL retain no partial state from the rejected message.

### Requirement 27: Property-Based Correctness Targets

**User Story:** As a system designer, I want explicit correctness properties that can be tested with property-based testing, so that I have confidence in the dispatcher and message-handling logic.

#### Acceptance Criteria

1. THE Dispatcher SHALL preserve the no-loss invariant that for any sequence of Request arrivals and Agent state transitions, every acknowledged Request reaches exactly one terminal state of completed, cancelled, failed, or queue-timeout.
2. WHILE all registered Agents are busy, THE Dispatcher SHALL deliver Requests to Agents in first-in-first-out order with respect to their Pending_Queue arrival order.
3. THE Dispatcher SHALL preserve the state-consistency invariant that for any sequence of Agent registrations and disconnections, the count of Busy_Agent instances plus the count of Idle_Agent instances equals the count of Agents currently registered and not marked as disconnected.
4. THE serializer and deserializer SHALL preserve the round-trip property that for any valid Request payload, applying serialize then deserialize yields a Request equal to the original.
5. THE streaming subsystem SHALL preserve the stream-consistency property that for any Stream_Chunk sequence belonging to a single Request, the concatenation of chunk text in arrival order equals the final assembled text reported with isFinal set to true.
6. THE Dispatcher SHALL preserve the request-mutual-exclusion invariant that no single Request is forwarded to more than one Agent at any point in time.
7. THE Dispatcher SHALL preserve the agent-mutual-exclusion invariant that no single Agent is concurrently assigned more than one Request at any point in time.
8. WHILE a Request remains in the Pending_Queue, IF its time-in-queue exceeds 600 seconds, THEN THE Dispatcher SHALL transition the Request to the "queue-timeout" terminal state and emit a corresponding failure Response.

### Requirement 28: Out-of-Scope Boundaries

**User Story:** As a stakeholder, I want explicit boundaries on what this feature does not do, so that scope is clear.

#### Acceptance Criteria

1. THE KIRO-GPT Bridge SHALL NOT replace, disable, or modify the KIRO_IDE native AI assistant.
2. THE KIRO-GPT Bridge SHALL operate as an additional, opt-in panel that is activated only by explicit user activation through a dedicated enable control.
3. THE KIRO-GPT Bridge SHALL NOT use the official OpenAI API and SHALL route all model interactions exclusively through the ChatGPT_Pro web UI controlled by the Browser_Agent.
4. THE KIRO-GPT Bridge SHALL NOT transmit user prompts, Code_Context, or Responses to any third-party service other than ChatGPT_Pro, including but not limited to analytics, telemetry, logging, or diagnostic endpoints.
5. THE KIRO-GPT Bridge SHALL NOT persist user prompts or Responses outside the user's local machine, except where the user explicitly invokes "Save as file" or "Save to workspace" via a UI control associated with the specific prompt or Response.
6. WHILE the KIRO-GPT Bridge panel is not enabled by the user, THE KIRO-GPT Bridge SHALL not intercept editor commands, modify the KIRO_IDE native AI assistant behavior, or initiate any outbound network connections.

### Requirement 29: Programmatic Image Generation API

**User Story:** As a developer (or as another extension or agent operating inside KIRO_IDE), I want a programmatic API on the KIRO_Extension that generates images via DALLE and saves them to the workspace, so that automated workflows can request visual assets without human interaction with the panel.

#### Acceptance Criteria

1. WHEN the KIRO_Extension activates, THE KIRO_Extension SHALL expose a public extension API (returned from `activate(ctx)`) containing a function `generateImage(options): Promise<ImageResult>` where `ImageResult` has the shape `{ requestId, savedPath?, mimeType?, prompt, errorCode?, message? }`.
2. THE generateImage function SHALL accept an options object with required field `prompt` (1–4000 chars) and optional fields `targetPath` (workspace-relative), `filename`, `framework` (string enum), `assetCategory` ∈ {"logo","hero","icon","illustration","background","mockup","other"}, and `overwrite` (boolean, default false).
3. WHEN generateImage is called, THE KIRO_Extension SHALL submit an image Request to the Relay_Server with type=image and SHALL await the final Response.
4. WHEN the image Response arrives with isFinal:true and base64 image data, THE KIRO_Extension SHALL decode the base64, write the image bytes atomically to the resolved path under the workspace root, and resolve the Promise with `{ requestId, savedPath, mimeType, prompt }`.
5. IF generateImage is called and no workspace folder is open, THEN THE KIRO_Extension SHALL resolve with `{ requestId, prompt, errorCode: "WORKSPACE_REQUIRED" }` without writing any file.
6. IF the resolved target path already exists and `overwrite` is false, THEN THE KIRO_Extension SHALL resolve with `{ requestId, prompt, errorCode: "TARGET_EXISTS", message }` without modifying the existing file.
7. IF image generation fails (CONTENT_POLICY, IMAGE_TIMEOUT, CHATGPT_UNAVAILABLE, INVALID_PROMPT, AGENT_DISCONNECTED), THEN THE KIRO_Extension SHALL resolve with `{ requestId, prompt, errorCode, message }` rather than rejecting, so callers branch on errorCode without try/catch.
8. WHEN an image is auto-generated through the API, THE KIRO_Extension SHALL show a non-blocking notification with the saved path and a "Reveal in Explorer" action.

### Requirement 30: Frontend Asset Workflow Automation

**User Story:** As a developer, I want the extension to detect my project's framework and place generated images in the conventional asset folder with sensible filenames, and to surface missing image references in my code with a one-click generate action, so that I do not manually choose a path or filename for every image.

#### Acceptance Criteria

1. WHEN generateImage is called without an explicit `targetPath`, THE KIRO_Extension SHALL detect the project framework by inspecting workspace files in this priority order: `next.config.{js,ts,mjs}` → "next", `nuxt.config.{js,ts,mjs}` → "nuxt", `svelte.config.js` → "sveltekit", `vite.config.{js,ts,mjs}` → "vite", `angular.json` → "angular", `package.json` whose dependencies include `react-scripts` → "cra", otherwise "unknown".
2. WHEN the framework is detected, THE KIRO_Extension SHALL select the asset folder per framework convention: next/nuxt/vite/cra → `public/`, sveltekit → `static/`, angular → `src/assets/`, unknown → `assets/`. Within the chosen folder, THE KIRO_Extension SHALL place images by `assetCategory`: logo → `logo/`, hero → `hero/`, icon → `icons/`, illustration → `illustrations/`, background → `backgrounds/`, mockup → `mockups/`, other → root.
3. WHEN generateImage is called without an explicit `filename`, THE KIRO_Extension SHALL derive a filename by slugifying the first 40 characters of the prompt (lowercase, ASCII a–z 0–9 and hyphens only, collapsed hyphens, no leading or trailing hyphen) and appending the MIME extension matching the response (.png, .jpg, .webp, .gif).
4. IF the derived path already exists and `overwrite` is false, THEN THE KIRO_Extension SHALL append `-2`, `-3`, …, `-99` before the extension until a unique path is found; if all 99 suffixes are taken, THE KIRO_Extension SHALL resolve with errorCode TARGET_EXISTS.
5. WHEN a final image Response is delivered through generateImage, THE KIRO_Extension SHALL ensure the chosen target directory exists, creating intermediate folders if missing.
6. WHEN code rendered in the panel or open editor contains image references of the forms `<img src="…" />`, `<Image src="…" />`, or `![alt](path)` whose resolved path is inside the workspace and does not exist on disk, THE KIRO_Extension SHALL display an inline "Generate this image" action next to each missing reference and, on click, SHALL call generateImage with a prompt derived from the alt text, surrounding code context, and inferred assetCategory.
7. THE KIRO_Extension SHALL register a command `kiroGptBridge.generateMissingAssets` that scans the active editor for missing image references and offers to generate all of them in a single confirmation prompt.
8. THE KIRO_Extension SHALL log every API-driven generation through the same structured logger used for panel-driven generation, with an additional field `origin` ∈ {"panel","api","missing-asset","mcp"}.

### Requirement 31: MCP Server for Visual Assets

**User Story:** As a Kiro main agent (or any MCP-aware tool) working autonomously on a frontend, I want a Model Context Protocol server exposed by this project that lets me request visual assets through tool calls, so that I can generate logos, heroes, icons, and UI mockups while writing code without going through a human-driven UI.

#### Acceptance Criteria

1. THE project SHALL include an MCP server implemented as a separate package `mcp-server/` that speaks MCP over stdio per the Model Context Protocol specification.
2. WHEN the MCP server starts, THE MCP_Server SHALL connect to the Relay_Server using a KIRO_Secret (read from environment variable `KIRO_GPT_MCP_SECRET`) and SHALL register as a KIRO_Client.
3. THE MCP_Server SHALL expose the following MCP tools, each accepting a `prompt` (1–4000 chars) plus tool-specific parameters and returning the saved file path on success or an `errorCode` on failure:
   - `generate_image(prompt, targetPath?, filename?, framework?, assetCategory?, overwrite?)`
   - `generate_logo(brand_name, style?, color_palette?, framework?, overwrite?)`
   - `generate_hero(scene_description, aspect_ratio?, framework?, overwrite?)`
   - `generate_icon_set(theme, names: string[], style?, framework?, overwrite?)`
   - `generate_ui_mockup(component_description, framework?, viewport?, overwrite?)`
4. WHEN any MCP tool is invoked, THE MCP_Server SHALL build the prompt by combining the tool-specific template with the user-supplied parameters and SHALL forward the request to the Relay_Server using the same image-Request flow as the extension API.
5. THE MCP_Server SHALL accept an optional `workspaceRoot` configuration (env var `KIRO_GPT_MCP_WORKSPACE` or per-call argument) so saved images land in the correct project folder when the MCP server runs outside KIRO_IDE.
6. WHEN an MCP tool succeeds, THE MCP_Server SHALL return a JSON result containing `savedPath`, `mimeType`, `prompt`, `requestId`, `assetCategory`, and (for `generate_icon_set`) `savedPaths: string[]`.
7. IF the Relay_Server is unreachable when an MCP tool is invoked, THEN THE MCP_Server SHALL return an MCP error with code `RELAY_UNREACHABLE` and SHALL NOT attempt to write any file.
8. THE project SHALL include an example `mcp.json` config snippet in the README documenting how to register `kiro-gpt-bridge` as an MCP server in `.kiro/settings/mcp.json` so the Kiro main agent picks it up automatically.

### Requirement 32: Steering and Hooks for Auto-Triggered Visual Generation

**User Story:** As a developer using Kiro to build frontends, I want the Kiro main agent to automatically reach for the kiro-gpt-bridge MCP tools whenever it generates UI code that needs visual assets, and I want a hook that scans newly-saved frontend files for missing assets so I never have to remember to ask, so that the visual side of the project stays in lockstep with the code.

#### Acceptance Criteria

1. THE project SHALL include a steering file at `.kiro/steering/visual-assets.md` whose `inclusion: fileMatch` front-matter matches frontend code files (`fileMatchPattern: "**/*.{tsx,jsx,vue,svelte,html,css,scss,astro}"`).
2. THE visual-assets steering file SHALL instruct the Kiro main agent that whenever it generates frontend code referencing a logo, hero image, icon, illustration, background, or UI mockup, it SHALL call the matching `generate_logo` / `generate_hero` / `generate_icon_set` / `generate_image` / `generate_ui_mockup` MCP tool from the kiro-gpt-bridge MCP server before finalizing the code, and SHALL update the code to reference the path returned by the tool.
3. THE visual-assets steering file SHALL document the available MCP tools, their parameters, and an example call so the main agent can use them without additional research.
4. THE project SHALL include a Kiro hook at `.kiro/hooks/generate-missing-assets.kiro.hook` of type `fileEdited` matching `**/*.{tsx,jsx,vue,svelte,html,astro}` that invokes the `kiroGptBridge.generateMissingAssets` command via an `askAgent` action whose prompt instructs the agent to run that command for the saved file.
5. THE project SHALL include a second Kiro hook at `.kiro/hooks/generate-spec-assets.kiro.hook` of type `userTriggered` (with title "Generate visual assets for active spec") whose `askAgent` prompt instructs the agent to read the active spec's design.md, identify every visual asset referenced (logos, hero images, icon sets, mockups), and generate them via the MCP tools into the workspace.
6. WHEN the kiro-gpt-bridge MCP server is active and the visual-assets steering is applied, THE Kiro main agent SHALL prefer the MCP tools over emitting placeholder paths or asking the user to provide images, except where the user has explicitly opted out via the user setting `kiroGptBridge.autoGenerateAssets: false`.
7. THE KIRO_Extension SHALL register a setting `kiroGptBridge.autoGenerateAssets` (boolean, default true) that controls the steering opt-out described in criterion 6; when false, the extension SHALL annotate the steering file at runtime with a notice that auto-generation is disabled.
8. THE README SHALL document the steering file, the two hooks, the auto-generation setting, and the recommended workflow ("plan in design.md → list visual assets → run the userTriggered hook → frontend code lands with real images already in the workspace").

