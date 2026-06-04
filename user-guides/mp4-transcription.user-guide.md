# User Guide: MP4 Transcription Agent

## Overview
The **MP4 Transcription Agent** (mp4-transcription) is an AI assistant designed to generate transcripts from MP4 files using the Whisper model. It is ideal for converting audio/video content into text for documentation, analysis, or accessibility purposes.

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **mp4-transcription** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the MP4 Transcription agent.

---

## What Context to Provide the Agent

- **MP4 File**: Provide the path to the MP4 file you want transcribed.
- **Additional Details (Optional)**: Specify if you want a particular model size (e.g., 'medium') or output format.
- **Relevant Project Context**: If the transcript is for a specific project or use case, mention this for more tailored results.

---

## How to Interact with the Agent

- Type your request in the Copilot prompt window (e.g., “Transcribe meeting_recording.mp4 using the Whisper model”).
- The agent will execute the transcription script using the command:
  - `python transcribe_mp4.py <mp4_file> medium`
- The agent will capture and display the transcript output.
- If you need the transcript in a specific format or location, specify this in your prompt.

### Example Interactions

- **Prompt:** “Transcribe interview.mp4 and save the output as interview.txt.”
- **Prompt:** “Generate a transcript from demo_video.mp4 using the medium Whisper model.”

---

## Agent-Specific Tips

- Ensure the MP4 file is accessible in the repository or provide the full path.
- You can request transcripts for multiple files by listing them in your prompt.
- For best results, specify any formatting or output preferences up front.

---

For further assistance, consult the repository documentation or contact the maintainers.
