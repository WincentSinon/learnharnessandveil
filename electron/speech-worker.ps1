# Fixed native worker, passed through -EncodedCommand. PDF text arrives only as
# JSON on stdin, never as PowerShell source, SSML, a path, or a command argument.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$nativeSpeech = @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;

public sealed class VeilSpeechWorker : IDisposable {
    private readonly object gate = new object();
    private readonly object outputGate = new object();
    private readonly SpeechSynthesizer synth;
    private Prompt prompt;
    private string requestId;
    private string status = "idle";
    private string failure;

    private VeilSpeechWorker(string outputFile) {
        synth = new SpeechSynthesizer();
        if (String.IsNullOrEmpty(outputFile)) synth.SetOutputToDefaultAudioDevice();
        else synth.SetOutputToWaveFile(outputFile);
        synth.SpeakCompleted += Completed;
    }

    private Dictionary<string, object> State() {
        var value = new Dictionary<string, object> { { "status", status }, { "requestId", requestId } };
        if (failure != null) value["error"] = failure;
        return value;
    }

    private void Send(object value) {
        lock (outputGate) {
            try { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
            catch (System.IO.IOException) { /* Parent closed its private pipe. */ }
        }
    }

    private void Changed() { Send(new Dictionary<string, object> { { "event", "state" }, { "value", State() } }); }

    private void Completed(object sender, SpeakCompletedEventArgs args) {
        lock (gate) {
            if (!Object.ReferenceEquals(args.Prompt, prompt)) return;
            prompt = null;
            status = args.Error == null ? "idle" : "error";
            failure = args.Error == null ? null : "Windows could not finish reading this page.";
            Changed();
        }
    }

    private void Cancel() {
        // Clear identity before cancellation; old callbacks cannot finish a new page.
        prompt = null;
        // Purge the paused queue first. Resuming before cancellation can leak
        // a fragment of the old page when the reader changes pages silently.
        synth.SpeakAsyncCancelAll();
        if (synth.State == SynthesizerState.Paused) synth.Resume();
    }

    private object Control(Dictionary<string, object> command) {
        var op = (string)command["op"];
        if (op == "voices") {
            var voices = new List<object>();
            foreach (var installed in synth.GetInstalledVoices()) {
                if (installed.Enabled) voices.Add(new Dictionary<string, object> {
                    { "name", installed.VoiceInfo.Name }, { "language", installed.VoiceInfo.Culture.Name }
                });
            }
            return voices;
        }
        if (op == "state") return State();
        if (op == "speak") {
            Cancel();
            requestId = (string)command["requestId"];
            synth.SelectVoice((string)command["voice"]);
            synth.Rate = Convert.ToInt32(command["rate"]);
            failure = null;
            status = "speaking";
            // SpeakAsync(string) always treats the PDF as plain text, never SSML.
            prompt = synth.SpeakAsync((string)command["text"]);
        } else if (op == "pause") {
            if (status == "speaking") { synth.Pause(); status = "paused"; }
        } else if (op == "resume") {
            if (status == "paused") { synth.Resume(); status = "speaking"; }
        } else if (op == "stop") {
            Cancel(); status = "idle"; failure = null;
        } else throw new ArgumentException("Unsupported speech control.");
        Changed();
        return State();
    }

    private void Run() {
        Send(new Dictionary<string, object> { { "event", "ready" } });
        string line;
        // Blocking stdin is intentional: C# completion handlers run without a
        // PowerShell runspace, so pause/stop and completion stay independent.
        while ((line = Console.ReadLine()) != null) {
            lock (gate) {
                string id = null;
                try {
                    if (line.Length > 650000) throw new ArgumentException("Speech command is too large.");
                    var json = new JavaScriptSerializer { MaxJsonLength = 650000 };
                    var command = json.Deserialize<Dictionary<string, object>>(line);
                    id = (string)command["id"];
                    var value = Control(command);
                    Send(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "value", value } });
                } catch (Exception) {
                    try { Cancel(); } catch { }
                    status = "error";
                    failure = "Windows could not complete the speech request. Try another installed voice.";
                    Changed();
                    Send(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", failure } });
                }
            }
        }
    }

    public void Dispose() {
        lock (gate) {
            prompt = null;
            synth.SpeakCompleted -= Completed;
            try { Cancel(); } finally { synth.Dispose(); }
        }
    }

    public static void Start(string outputFile) {
        try { using (var worker = new VeilSpeechWorker(outputFile)) worker.Run(); }
        catch (Exception) {
            Console.WriteLine("{\"event\":\"fatal\",\"error\":\"Windows speech could not be initialized.\"}");
            Console.Out.Flush();
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $nativeSpeech -ReferencedAssemblies @('System.Speech', 'System.Web.Extensions')
    [VeilSpeechWorker]::Start($env:VEIL_SPEECH_WAVE_OUTPUT)
} catch {
    [Console]::WriteLine('{"event":"fatal","error":"Windows speech could not be initialized."}')
    [Console]::Out.Flush()
}
