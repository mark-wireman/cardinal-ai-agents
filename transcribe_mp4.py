
# Standard library imports
import os  # For file and directory operations
import subprocess  # (Unused, but often used for running shell commands)
import whisper  # OpenAI Whisper for transcription
import argparse  # For command-line argument parsing
import uuid  # For generating unique IDs for output files

 

def transcribe_audio(audio_path, model_size="base"):
    """
    Transcribes the given audio file using OpenAI Whisper.
    Args:
        audio_path (str): Path to the audio (MP4) file.
        model_size (str): Whisper model size to use (e.g., 'base', 'medium').
    Returns:
        str: The transcribed text.
    Raises:
        RuntimeError: If transcription fails.
    """
    try:
        model = whisper.load_model(model_size)
        result = model.transcribe(audio_path)
        return result["text"]
    except Exception as e:
        raise RuntimeError(f"Transcription failed: {e}")
 


def save_transcript(transcript, transcript_path):
    """
    Saves the transcript text to a file.
    Args:
        transcript (str): The transcribed text.
        transcript_path (str): Path to save the transcript file.
    Raises:
        IOError: If saving fails.
    """
    try:
        with open(transcript_path, "w", encoding="utf-8") as f:
            f.write(transcript)
    except Exception as e:
        raise IOError(f"Failed to save transcript: {e}")


def add_to_path_if_missing(directory):
    """
    Adds a directory to the system PATH if it's not already present.
    Args:
        directory (str): Directory to add to PATH.
    """
    if directory not in os.environ["PATH"]:
        os.environ["PATH"] += os.pathsep + directory


# Main script entry point
if __name__ == "__main__":
    # Set up command-line argument parsing
    parser = argparse.ArgumentParser(description="Transcribe MP4 recording(s) to text using Whisper.")
    parser.add_argument("input_path", help="Path to the MP4 file or directory containing MP4 files to transcribe.")
    parser.add_argument("output_file", nargs="?", default=None, help="Path to save the transcript text file (for single file input only).")
    parser.add_argument("--ffmpeg_path", default=r"C:\\Users\\mark.wireman\\OneDrive - Cardinal Health\\Documents\\ffmpeg\\bin", help="Path to ffmpeg bin directory (optional, default is your user path).")
    parser.add_argument("--model_size", default="base", help="Whisper model size to use (default: base).")
    args = parser.parse_args()

    # Ensure ffmpeg is available in PATH for Whisper to use
    add_to_path_if_missing(args.ffmpeg_path)

    # Check if input is a file or directory
    if os.path.isfile(args.input_path):
        # Single file mode: transcribe one MP4 file
        result = transcribe_audio(args.input_path, args.model_size)
        # Use provided output file name or default to <input>_transcript.txt
        output_file = args.output_file if args.output_file else os.path.splitext(os.path.basename(args.input_path))[0] + "_transcript.txt"
        save_transcript(result, output_file)
        print(f"Transcription complete. Output saved to {output_file}")
    elif os.path.isdir(args.input_path):
        # Directory mode: process all MP4 files in the directory
        mp4_files = [f for f in os.listdir(args.input_path) if f.lower().endswith('.mp4') and os.path.isfile(os.path.join(args.input_path, f))]
        if not mp4_files:
            print(f"No MP4 files found in directory: {args.input_path}")
        for mp4_file in mp4_files:
            full_mp4_path = os.path.join(args.input_path, mp4_file)
            print(f"Transcribing {full_mp4_path} ...")
            try:
                # Transcribe each MP4 file
                result = transcribe_audio(full_mp4_path, args.model_size)
                # Generate a unique output file name using a GUID
                guid = uuid.uuid4().hex
                base_name = os.path.splitext(mp4_file)[0]
                output_file = f"C:\\Users\\mark.wireman\\Downloads\\transcript_extraction_local\\transcripts\\{base_name}_{guid}_transcript.txt"
                save_transcript(result, output_file)
                print(f"Transcription complete. Output saved to {output_file}")
            except Exception as e:
                print(f"Failed to transcribe {mp4_file}: {e}")
    else:
        # Invalid input path
        print(f"Input path is neither a file nor a directory: {args.input_path}")
