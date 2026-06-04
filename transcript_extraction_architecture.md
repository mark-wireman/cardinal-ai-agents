# Transcript Extraction Local – Technical Architecture & Implementation

## Overview

The transcript extraction local solution enables automated transcription of audio from MP4 video files using local machine learning models (OpenAI Whisper and optionally Ollama-based models). The system is designed for batch processing of recordings, producing text transcripts for downstream analysis, requirements gathering, and compliance.

---

## 1. High-Level Architecture

### Components

- **Recording Input**: MP4 video files stored in a designated directory.
- **Audio Extraction & Transcription**: Python scripts leveraging local ML models (Whisper, Ollama) to transcribe audio.
- **Transcript Output**: Text files written to a target directory for each processed video.
- **Model Assets**: Local model weights (e.g., base.pt, medium.pt, large.pt, tiny.pt) for Whisper and other models.
- **Optional Advanced Analysis**: Integration with Ollama for frame-based video analysis and summary generation.

### Directory Structure

- `/recordings/`: Input MP4 files.
- `/transcripts/`: Output transcript text files.
- Model files: `base.pt`, `medium.pt`, `large.pt`, `tiny.pt`, etc.
- Main scripts: `transcribe_mp4.py`, `ollma_transcribe.py`.

---

## 2. Design Details

### 2.1. Batch Transcription Pipeline

#### Main Script: `transcribe_mp4.py`

- **Purpose**: Batch process all MP4 files in a directory, transcribe audio, and save transcripts.
- **Key Functions**:
  - `transcribe_audio(audio_path, model_size="base")`: Loads the specified Whisper model and transcribes the given audio file.
  - `mp4_to_transcript(mp4_path, transcript_path="transcript.txt")`: Iterates over all MP4s in the input directory, transcribes each, and writes the output to a text file.

- **Model Selection**: The script supports different Whisper model sizes (base, medium, large, tiny) for trade-offs between speed and accuracy.

- **Output Naming**: Output files are named based on the input video, sanitized for filesystem compatibility.

- **Error Handling**: Exceptions during transcription are caught and reported.

#### Example Usage

```python
if __name__ == "__main__":
    mp4_file = "recordings"
    mp4_to_transcript(mp4_file)
```

### 2.2. Advanced Video Analysis (Optional)

#### Script: `ollma_transcribe.py`

- **Purpose**: Uses the Ollama framework for advanced video analysis, including frame selection, visual analysis, and integrated audio-visual summaries.
- **Key Features**:
  - Frame extraction and selection using `DynamicFrameSelector`.
  - Audio transcription via Whisper.
  - Customizable prompts for frame analysis and summary generation.
  - Outputs include brief and detailed summaries, timelines, and metadata.

- **Integration**: This script is modular and can be extended for more complex video understanding tasks.

---

## 3. Implementation Details

### 3.1. Model Management

- **Local Models**: All Whisper model weights are stored locally to avoid network dependencies and ensure data privacy.
- **Model Loading**: Models are loaded on demand per transcription job.

### 3.2. Audio Extraction

- **Direct Transcription**: The script assumes Whisper can process MP4 files directly. If not, audio extraction (e.g., via ffmpeg) can be added as a preprocessing step.

### 3.3. Output Management

- **Transcript Files**: Each transcript is saved as a `.txt` file in the `/transcripts/` directory, named after the source video.
- **Logging**: Progress and errors are printed to the console for monitoring.

### 3.4. Extensibility

- **Model Size**: Easily switch between model sizes for different performance needs.
- **Directory Structure**: Designed for batch processing and easy integration with other tools.
- **Advanced Analysis**: Ollama integration allows for future expansion into multi-modal video analysis.

---

## 4. Example Workflow

1. Place MP4 files in `/recordings/`.
2. Run `transcribe_mp4.py` to generate transcripts in `/transcripts/`.
3. (Optional) Run `ollma_transcribe.py` for advanced analysis and summaries.

---

## 5. Security & Compliance

- **Local Processing**: All transcription is performed locally; no data is sent to external servers.
- **Model Assets**: Ensure model files are stored securely and access is controlled.

---

## 6. Dependencies

- Python 3.x
- `whisper` Python package (for Whisper models)
- `openscenesense_ollama` (for advanced Ollama analysis)
- (Optional) `ffmpeg` for audio extraction if needed

---

## 7. Future Enhancements

- Add audio extraction for non-MP4 formats.
- Integrate with requirements extraction and analysis pipelines.
- Add error logging and reporting.
- Support for additional languages and models.

---

Let me know if you need further details on any section!
