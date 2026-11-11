// ThodDrop quick-receive agent.
//
// A deliberately small background process for the "static link" mode:
//  - listens on the LAN (default 47776);
//  - starts the full worker on demand (default 47778) and keeps it only while
//    the normal ThodDrop window is not running;
//  - forwards phone traffic to the worker as raw TCP, so uploads and downloads
//    are streamed without buffering in this process;
//  - exposes only a tiny loopback control API for the PC settings window.
//
// It never talks to the internet and never stores the pairing keys: those stay
// in the worker's data directory.

using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace ThodDropAgent;

internal sealed class QuickConfig
{
    public bool Enabled { get; init; }
    public int Port { get; init; } = 47776;
    public int WorkerPort { get; init; } = 47778;
    public int NormalPort { get; init; } = 47777;
    public string Worker { get; init; } = "";
    public string DataDir { get; init; } = "";
    public string Home { get; init; } = "";
    public string DownloadDir { get; init; } = "";
}

internal static class Program
{
    private const string MutexName = @"Local\ThodDropQuickAgent";
    private static readonly object LogLock = new();

    private static string _logPath = "";
    private static string _pidPath = "";
    private static string _configDir = "";

    internal static string ConfigDir => _configDir;

    public static int Main(string[] args)
    {
        var configPath = ResolveConfigPath(args);
        var configDir = Path.GetDirectoryName(configPath) ?? AppContext.BaseDirectory;
        _configDir = configDir;
        _logPath = Path.Combine(configDir, "quick-agent.log");
        _pidPath = Path.Combine(configDir, "quick-agent.pid");
        TrimLog();

        using var mutex = new Mutex(true, MutexName, out var created);
        if (!created) return 0;

        QuickConfig config;
        try
        {
            if (!File.Exists(configPath))
            {
                Log($"config not found: {configPath}");
                return 0;
            }
            config = ReadConfig(configPath);
        }
        catch (Exception e)
        {
            Log($"cannot read config: {e.Message}");
            return 1;
        }
        if (!config.Enabled)
        {
            Log("quick mode is disabled");
            return 0;
        }
        if (config.Port <= 0 || config.Port > 65535 ||
            config.WorkerPort <= 0 || config.WorkerPort > 65535 ||
            config.NormalPort <= 0 || config.NormalPort > 65535)
        {
            Log("invalid ports");
            return 1;
        }

        try
        {
            File.WriteAllText(_pidPath, Environment.ProcessId.ToString());
        }
        catch
        {
            // the settings window can still stop us through the control API
        }

        using var agent = new Agent(config);
        try
        {
            agent.Run();
            return 0;
        }
        catch (Exception e)
        {
            Log($"fatal: {e}");
            return 1;
        }
        finally
        {
            TryDelete(_pidPath);
        }
    }

    private static string ResolveConfigPath(string[] args)
    {
        for (var i = 0; i + 1 < args.Length; i++)
            if (args[i] == "--config") return Path.GetFullPath(args[i + 1]);
        var env = Environment.GetEnvironmentVariable("THODDROP_QUICK_CONFIG");
        if (!string.IsNullOrWhiteSpace(env)) return Path.GetFullPath(env);
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ThodHUB", "Data", "thoddrop", "core", "quick.json");
    }

    private static QuickConfig ReadConfig(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var r = doc.RootElement;
        string Str(string name, string fallback) =>
            r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? fallback)
                : fallback;
        int Int(string name, int fallback) =>
            r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)
                ? n
                : fallback;
        bool Bool(string name, bool fallback) =>
            r.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
                ? v.GetBoolean()
                : fallback;
        var worker = Str("worker", "");
        if (!string.IsNullOrWhiteSpace(worker) && !Path.IsPathRooted(worker))
            worker = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path) ?? "", worker));
        return new QuickConfig
        {
            Enabled = Bool("enabled", false),
            Port = Int("port", 47776),
            WorkerPort = Int("workerPort", 47778),
            NormalPort = Int("normalPort", 47777),
            Worker = worker,
            DataDir = Str("dataDir", ""),
            Home = Str("home", ""),
            DownloadDir = Str("downloadDir", ""),
        };
    }

    private static void TrimLog()
    {
        try
        {
            if (File.Exists(_logPath) && new FileInfo(_logPath).Length > 512 * 1024)
                File.WriteAllText(_logPath, "");
        }
        catch
        {
            // logging is best effort
        }
    }

    internal static void Log(string message)
    {
        lock (LogLock)
        {
            try
            {
                File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
            }
            catch
            {
                // logging must never take the agent down
            }
        }
    }

    internal static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // ignore
        }
    }

    internal static bool TryReadPid(string path, out int pid)
    {
        pid = 0;
        try
        {
            return File.Exists(path) && int.TryParse(File.ReadAllText(path).Trim(), out pid) && pid > 0;
        }
        catch
        {
            return false;
        }
    }
}

internal sealed class Agent : IDisposable
{
    private readonly QuickConfig _config;
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _workerLock = new();
    private Process? _quickWorker;

    public Agent(QuickConfig config)
    {
        _config = config;
        _listener = new TcpListener(IPAddress.Any, config.Port);
    }

    public void Run()
    {
        _listener.Start();
        Program.Log($"agent started on 0.0.0.0:{_config.Port}, worker port {_config.WorkerPort}");
        var monitor = Task.Run(() => MonitorAsync(_cts.Token));
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = _listener.AcceptTcpClientAsync(_cts.Token).GetAwaiter().GetResult();
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (SocketException)
                {
                    break;
                }
                _ = Task.Run(() => HandleAsync(client, _cts.Token));
            }
        }
        finally
        {
            _cts.Cancel();
            try { _listener.Stop(); } catch { }
            StopQuickWorker();
            try { monitor.Wait(2000); } catch { }
            Program.Log("agent stopped");
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        StopQuickWorker();
        _cts.Dispose();
    }

    private async Task HandleAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                client.ReceiveTimeout = 15000;
                var stream = client.GetStream();
                var header = await ReadHeaderAsync(stream, ct);
                if (header is null) return;
                var bytes = header.Value.Bytes;
                var firstLineEnd = IndexOf(bytes, 0, header.Value.HeaderEnd, "\r\n"u8);
                var firstLine = Encoding.ASCII.GetString(bytes, 0, firstLineEnd < 0 ? header.Value.HeaderEnd : firstLineEnd);
                var parts = firstLine.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2)
                {
                    await WriteResponseAsync(stream, 400, "Bad Request", "{\"error\":\"bad request\"}", ct);
                    return;
                }
                var path = parts[1].Split('?')[0];
                var remote = (client.Client.RemoteEndPoint as IPEndPoint)?.Address;

                if (path.StartsWith("/__quick/", StringComparison.Ordinal))
                {
                    if (remote is null || !IPAddress.IsLoopback(remote))
                    {
                        await WriteResponseAsync(stream, 403, "Forbidden", "{\"error\":\"loopback only\"}", ct);
                        return;
                    }
                    await HandleControlAsync(stream, path, ct);
                    return;
                }

                if (!AllowedPath(path))
                {
                    await WriteResponseAsync(stream, 403, "Forbidden", "{\"error\":\"not allowed\"}", ct);
                    return;
                }

                var targetPort = await EnsureTargetAsync();
                if (targetPort == 0)
                {
                    await WriteResponseAsync(stream, 503, "Service Unavailable",
                        "{\"error\":\"worker_start_failed\"}", ct);
                    return;
                }

                using var upstream = new TcpClient();
                using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    connectCts.CancelAfter(5000);
                    try
                    {
                        await upstream.ConnectAsync(IPAddress.Loopback, targetPort, connectCts.Token);
                    }
                    catch
                    {
                        await WriteResponseAsync(stream, 502, "Bad Gateway", "{\"error\":\"worker_unreachable\"}", ct);
                        return;
                    }
                }

                var up = upstream.GetStream();
                await up.WriteAsync(bytes.AsMemory(0, bytes.Length), ct);
                await up.FlushAsync(ct);
                var c2u = PumpAsync(stream, up, ct);
                var u2c = PumpAsync(up, stream, ct);
                try
                {
                    await Task.WhenAll(c2u, u2c);
                }
                catch (Exception e) when (e is IOException or ObjectDisposedException or OperationCanceledException)
                {
                    // normal when the phone or the worker closes the connection
                }
            }
            catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException or OperationCanceledException)
            {
                // client went away
            }
            catch (Exception e)
            {
                Program.Log($"request error: {e.Message}");
            }
        }
    }

    private async Task HandleControlAsync(NetworkStream stream, string path, CancellationToken ct)
    {
        if (path == "/__quick/status")
        {
            var target = await CurrentTargetAsync();
            var body =
                "{\"enabled\":true,\"running\":true," +
                $"\"port\":{_config.Port},\"workerPort\":{_config.WorkerPort}," +
                $"\"targetPort\":{target},\"url\":\"{PublicUrl()}\"," +
                $"\"quickWorker\":{(target == _config.WorkerPort ? "true" : "false")}}}";
            await WriteResponseAsync(stream, 200, "OK", body, ct);
            return;
        }
        if (path == "/__quick/stop")
        {
            await WriteResponseAsync(stream, 200, "OK", "{\"ok\":true}", ct);
            Program.Log("stop requested");
            _cts.Cancel();
            try { _listener.Stop(); } catch { }
            return;
        }
        if (path == "/__quick/ping")
        {
            await WriteResponseAsync(stream, 200, "OK", "{\"ok\":true}", ct);
            return;
        }
        await WriteResponseAsync(stream, 404, "Not Found", "{\"error\":\"unknown\"}", ct);
    }

    private async Task MonitorAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(1000, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            // The normal ThodDrop window owns its port. If it appears, yield:
            // one worker at a time shares the same devices/history safely.
            if (_config.NormalPort != _config.WorkerPort && await PortOpenAsync(_config.NormalPort) &&
                (IsQuickWorkerRunning() || WorkerPidAlive()))
            {
                Program.Log("normal ThodDrop worker detected, stopping quick worker");
                StopQuickWorker();
            }
        }
    }

    private async Task<int> EnsureTargetAsync()
    {
        if (_config.NormalPort != _config.WorkerPort && await PortOpenAsync(_config.NormalPort)) return _config.NormalPort;
        // Adopt a worker left by a previous agent run, but never proxy phone
        // data to whatever unrelated program happens to listen on our port.
        if (await PortOpenAsync(_config.WorkerPort) && (WorkerPidAlive() || IsQuickWorkerRunning())) return _config.WorkerPort;
        if (!StartQuickWorker()) return 0;
        var until = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < until && !_cts.IsCancellationRequested)
        {
            if (_config.NormalPort != _config.WorkerPort && await PortOpenAsync(_config.NormalPort))
            {
                StopQuickWorker();
                return _config.NormalPort;
            }
            if (await PortOpenAsync(_config.WorkerPort) && (WorkerPidAlive() || IsQuickWorkerRunning())) return _config.WorkerPort;
            try { await Task.Delay(200, _cts.Token); } catch (OperationCanceledException) { break; }
        }
        return 0;
    }

    private async Task<int> CurrentTargetAsync()
    {
        if (_config.NormalPort != _config.WorkerPort && await PortOpenAsync(_config.NormalPort)) return _config.NormalPort;
        if (await PortOpenAsync(_config.WorkerPort) && (WorkerPidAlive() || IsQuickWorkerRunning())) return _config.WorkerPort;
        return 0;
    }

    private static bool WorkerPidAlive()
    {
        if (!Program.TryReadPid(ProgramPath("quick-worker.pid"), out var pid)) return false;
        try
        {
            using var p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private bool IsQuickWorkerRunning()
    {
        lock (_workerLock)
        {
            return _quickWorker is { HasExited: false };
        }
    }

    private bool StartQuickWorker()
    {
        lock (_workerLock)
        {
            if (_quickWorker is { HasExited: false }) return true;
            if (string.IsNullOrWhiteSpace(_config.Worker) || !File.Exists(_config.Worker))
            {
                Program.Log($"worker not found: {_config.Worker}");
                return false;
            }
            KillStaleQuickWorker();
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = _config.Worker,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = Path.GetDirectoryName(_config.Worker) ?? AppContext.BaseDirectory,
                };
                if (!string.IsNullOrWhiteSpace(_config.DataDir))
                    psi.Environment["THODHUB_DATA_DIR"] = _config.DataDir;
                psi.Environment["THODDROP_PORT"] = _config.WorkerPort.ToString();
                psi.Environment["THODDROP_PUBLIC_PORT"] = _config.Port.ToString();
                psi.Environment["THODDROP_STRICT_PORT"] = "1";
                psi.Environment["THODDROP_QUICK"] = "1";

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.Exited += (_, _) =>
                {
                    try { Program.Log($"quick worker exited ({p.ExitCode})"); } catch { }
                    bool mine;
                    lock (_workerLock)
                    {
                        mine = ReferenceEquals(_quickWorker, p);
                        if (mine) _quickWorker = null;
                    }
                    if (mine) Program.TryDelete(ProgramPath("quick-worker.pid"));
                };
                if (!p.Start())
                {
                    p.Dispose();
                    return false;
                }
                _quickWorker = p;
                try { File.WriteAllText(ProgramPath("quick-worker.pid"), p.Id.ToString()); } catch { }
                _ = DrainAsync(p.StandardOutput, "worker-out");
                _ = DrainAsync(p.StandardError, "worker-err");
                Program.Log($"quick worker started (pid {p.Id}) on port {_config.WorkerPort}");
                return true;
            }
            catch (Exception e)
            {
                Program.Log($"cannot start quick worker: {e.Message}");
                return false;
            }
        }
    }

    private void KillStaleQuickWorker()
    {
        if (Program.TryReadPid(ProgramPath("quick-worker.pid"), out var pid))
        {
            try
            {
                using var old = Process.GetProcessById(pid);
                old.Kill(true);
                old.WaitForExit(1200);
            }
            catch
            {
                // already gone
            }
        }
        Program.TryDelete(ProgramPath("quick-worker.pid"));
    }

    private void StopQuickWorker()
    {
        Process? p;
        lock (_workerLock)
        {
            p = _quickWorker;
            _quickWorker = null;
        }
        if (p is not null)
        {
            try
            {
                if (!p.HasExited)
                {
                    try { p.StandardInput.Close(); } catch { }
                    if (!p.WaitForExit(2500)) p.Kill(true);
                }
            }
            catch
            {
                // already exited
            }
            finally
            {
                p.Dispose();
            }
        }
        else if (Program.TryReadPid(ProgramPath("quick-worker.pid"), out var pid))
        {
            // worker left by a previous agent run
            try
            {
                using var old = Process.GetProcessById(pid);
                old.Kill(true);
                old.WaitForExit(1500);
            }
            catch
            {
                // already gone
            }
        }
        Program.TryDelete(ProgramPath("quick-worker.pid"));
    }

    private static async Task DrainAsync(StreamReader reader, string tag)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
                Program.Log($"{tag}: {line}");
        }
        catch
        {
            // process closed
        }
    }

    private static async Task PumpAsync(NetworkStream from, NetworkStream to, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var n = await from.ReadAsync(buffer, ct);
                if (n <= 0) break;
                await to.WriteAsync(buffer.AsMemory(0, n), ct);
                await to.FlushAsync(ct);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // one side closed
        }
        try { to.Socket.Shutdown(SocketShutdown.Send); } catch { }
    }

    private static async Task<(byte[] Bytes, int HeaderEnd)?> ReadHeaderAsync(NetworkStream stream, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        var len = 0;
        // Slowloris: a LAN device must not hold a connection open by sending
        // half a request. The whole header has to arrive within 15 seconds.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(15000);
        while (len < buffer.Length)
        {
            int n;
            try
            {
                n = await stream.ReadAsync(buffer.AsMemory(len, buffer.Length - len), timeout.Token);
            }
            catch (Exception e) when (e is IOException or OperationCanceledException)
            {
                return null;
            }
            if (n <= 0) break;
            len += n;
            var end = FindHeaderEnd(buffer, len);
            if (end >= 0) return (buffer[..len], end);
        }
        return null;
    }

    private static int FindHeaderEnd(byte[] buffer, int len)
    {
        for (var i = 0; i + 3 < len; i++)
        {
            if (buffer[i] == '\r' && buffer[i + 1] == '\n' && buffer[i + 2] == '\r' && buffer[i + 3] == '\n')
                return i;
        }
        return -1;
    }

    private static int IndexOf(byte[] buffer, int start, int end, ReadOnlySpan<byte> needle)
    {
        for (var i = start; i + needle.Length <= end; i++)
        {
            var ok = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (buffer[i + j] != needle[j])
                {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return -1;
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int status, string reason, string body, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = $"HTTP/1.1 {status} {reason}\r\n" +
                   "Content-Type: application/json; charset=utf-8\r\n" +
                   $"Content-Length: {bytes.Length}\r\n" +
                   "Connection: close\r\n" +
                   "Cache-Control: no-store\r\n\r\n";
        try
        {
            await stream.WriteAsync(Encoding.ASCII.GetBytes(head), ct);
            await stream.WriteAsync(bytes, ct);
            await stream.FlushAsync(ct);
        }
        catch
        {
            // client left
        }
    }

    private static bool AllowedPath(string path)
    {
        if (path is "/" or "/s" or "/favicon.ico") return true;
        return path.StartsWith("/s/", StringComparison.Ordinal) ||
               path.StartsWith("/assets/", StringComparison.Ordinal) ||
               path == "/api/phone" ||
               path.StartsWith("/api/phone/", StringComparison.Ordinal);
    }

    private static async Task<bool> PortOpenAsync(int port)
    {
        try
        {
            using var client = new TcpClient();
            using var cts = new CancellationTokenSource(350);
            await client.ConnectAsync(IPAddress.Loopback, port, cts.Token);
            return client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private string PublicUrl() => $"http://{LanIPv4()}:{_config.Port}/s/";

    private static string LanIPv4()
    {
        string? fallback = null;
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up ||
                    ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    var b = ua.Address.GetAddressBytes();
                    if (b[0] == 169 && b[1] == 254) continue;
                    fallback ??= ua.Address.ToString();
                    if (b[0] == 10 || (b[0] == 192 && b[1] == 168) ||
                        (b[0] == 172 && b[1] >= 16 && b[1] <= 31))
                        return ua.Address.ToString();
                }
            }
        }
        catch
        {
            // network info unavailable
        }
        return fallback ?? "127.0.0.1";
    }

    private static string ProgramPath(string name)
    {
        // Files next to the agent config (the worker's core directory).
        return Path.Combine(string.IsNullOrEmpty(Program.ConfigDir) ? AppContext.BaseDirectory : Program.ConfigDir, name);
    }
}
