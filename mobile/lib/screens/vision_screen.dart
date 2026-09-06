import 'dart:async';
import 'dart:math' as math;
import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart';
import '../theme/app_theme.dart';

/// NOTE ON IMPLEMENTATION CHOICE: ML Kit's live-video-frame pipeline
/// (CameraImage -> InputImage, with per-platform YUV/BGRA byte-plane
/// handling and sensor-rotation math) is the single most version- and
/// device-fragile part of the Flutter camera/ML Kit ecosystem, and this
/// code was never run against a real device or emulator. To keep this
/// reliable enough to actually work on first try, this screen instead
/// takes rapid still photos (takePicture -> InputImage.fromFilePath) in a
/// loop rather than processing a live camera stream. You get a slightly
/// lower frame rate (roughly 2-4 checks/sec depending on the device) and
/// no skeleton-dot overlay on the preview, in exchange for using the much
/// more stable file-based InputImage API. If you want true live-stream
/// pose tracking, see google_mlkit_pose_detection's example app for the
/// CameraImage conversion helper and swap `_captureAndProcess` for a
/// `controller.startImageStream(...)` callback.

enum ExerciseType { squat, curl, pushup }

class _ExerciseConfig {
  final String label;
  final double upThreshold;
  final double downThreshold;
  final String Function(double angle, bool isDown) feedback;
  const _ExerciseConfig(this.label, this.upThreshold, this.downThreshold, this.feedback);
}

final _configs = <ExerciseType, _ExerciseConfig>{
  ExerciseType.squat: _ExerciseConfig(
    "Squat",
    160,
    100,
    (angle, isDown) {
      if (isDown && angle > 110) return "Go a little lower";
      if (isDown) return "Good depth";
      return "Stand tall, then squat down";
    },
  ),
  ExerciseType.curl: _ExerciseConfig(
    "Curl",
    150,
    50,
    (angle, isDown) {
      if (isDown && angle > 60) return "Curl a bit higher";
      if (isDown) return "Nice squeeze";
      return "Extend fully between reps";
    },
  ),
  ExerciseType.pushup: _ExerciseConfig(
    "Push-up",
    150,
    90,
    (angle, isDown) {
      if (isDown && angle > 100) return "Lower your chest more";
      if (isDown) return "Good depth";
      return "Lock out at the top";
    },
  ),
};

class VisionScreen extends StatefulWidget {
  const VisionScreen({super.key});
  @override
  State<VisionScreen> createState() => _VisionScreenState();
}

class _VisionScreenState extends State<VisionScreen> {
  CameraController? _controller;
  PoseDetector? _detector;
  ExerciseType _exercise = ExerciseType.squat;
  bool _running = false;
  bool _busy = false;
  int _reps = 0;
  double _angle = 0;
  bool _isDown = false;
  String _feedback = "";
  String? _error;

  @override
  void dispose() {
    _running = false;
    _controller?.dispose();
    _detector?.close();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() => _error = null);
    if (kIsWeb) {
      // Google's ML Kit is Android/iOS only — it has no web implementation
      // at all, so there's nothing to fall back to here (unlike
      // mobile_scanner's QR reader, which does ship a web/ZXing backend).
      setState(() => _error =
          "Vision Coach's pose detection only runs on the installed Android/iOS app — Google's ML Kit doesn't support browsers. Everything else in this app works on web.");
      return;
    }
    try {
      final cameras = await availableCameras();
      final camera = cameras.firstWhere((c) => c.lensDirection == CameraLensDirection.front, orElse: () => cameras.first);
      final controller = CameraController(camera, ResolutionPreset.medium, enableAudio: false);
      await controller.initialize();
      _detector = PoseDetector(options: PoseDetectorOptions(mode: PoseDetectionMode.single));
      setState(() {
        _controller = controller;
        _running = true;
      });
      _loop();
    } catch (e) {
      setState(() => _error = "Couldn't start the camera: $e");
    }
  }

  Future<void> _stop() async {
    _running = false;
    await _controller?.dispose();
    await _detector?.close();
    setState(() {
      _controller = null;
      _detector = null;
    });
  }

  void _resetReps() {
    setState(() {
      _reps = 0;
      _isDown = false;
      _angle = 0;
      _feedback = "";
    });
  }

  Future<void> _loop() async {
    while (_running && mounted) {
      if (!_busy) {
        await _captureAndProcess();
      }
      await Future.delayed(const Duration(milliseconds: 250));
    }
  }

  Future<void> _captureAndProcess() async {
    if (_controller == null || _detector == null || !_controller!.value.isInitialized) return;
    _busy = true;
    try {
      final file = await _controller!.takePicture();
      // InputImage.fromFilePath needs a real filesystem path, which only
      // exists on Android/iOS — this whole method only ever runs there
      // (see the kIsWeb guard in _start), so file.path is safe here.
      final inputImage = InputImage.fromFilePath(file.path);
      final poses = await _detector!.processImage(inputImage);
      if (poses.isNotEmpty && mounted) {
        _processPose(poses.first);
      }
    } catch (_) {
      // Transient capture/detection errors are expected occasionally
      // (device busy, no pose in frame) — just skip this tick.
    } finally {
      _busy = false;
    }
  }

  PoseLandmark? _pick(Pose pose, PoseLandmarkType left, PoseLandmarkType right) {
    final l = pose.landmarks[left];
    final r = pose.landmarks[right];
    if (l == null) return r;
    if (r == null) return l;
    return (l.likelihood >= r.likelihood) ? l : r;
  }

  double _angleBetween(PoseLandmark a, PoseLandmark b, PoseLandmark c) {
    final abX = a.x - b.x, abY = a.y - b.y;
    final cbX = c.x - b.x, cbY = c.y - b.y;
    final dot = abX * cbX + abY * cbY;
    final magAB = math.sqrt(abX * abX + abY * abY);
    final magCB = math.sqrt(cbX * cbX + cbY * cbY);
    if (magAB == 0 || magCB == 0) return 0;
    final cos = (dot / (magAB * magCB)).clamp(-1.0, 1.0);
    return math.acos(cos) * 180 / math.pi;
  }

  void _processPose(Pose pose) {
    double? angle;

    switch (_exercise) {
      case ExerciseType.squat:
        final hip = _pick(pose, PoseLandmarkType.leftHip, PoseLandmarkType.rightHip);
        final knee = _pick(pose, PoseLandmarkType.leftKnee, PoseLandmarkType.rightKnee);
        final ankle = _pick(pose, PoseLandmarkType.leftAnkle, PoseLandmarkType.rightAnkle);
        if (hip != null && knee != null && ankle != null) angle = _angleBetween(hip, knee, ankle);
        break;
      case ExerciseType.curl:
      case ExerciseType.pushup:
        final shoulder = _pick(pose, PoseLandmarkType.leftShoulder, PoseLandmarkType.rightShoulder);
        final elbow = _pick(pose, PoseLandmarkType.leftElbow, PoseLandmarkType.rightElbow);
        final wrist = _pick(pose, PoseLandmarkType.leftWrist, PoseLandmarkType.rightWrist);
        if (shoulder != null && elbow != null && wrist != null) angle = _angleBetween(shoulder, elbow, wrist);
        break;
    }

    if (angle == null) return;
    final config = _configs[_exercise]!;

    bool nextIsDown = _isDown;
    int nextReps = _reps;
    if (!_isDown && angle < config.downThreshold) {
      nextIsDown = true;
    } else if (_isDown && angle > config.upThreshold) {
      nextIsDown = false;
      nextReps += 1;
    }

    if (!mounted) return;
    setState(() {
      _angle = angle!;
      _isDown = nextIsDown;
      _reps = nextReps;
      _feedback = config.feedback(angle, nextIsDown);
    });
  }

  @override
  Widget build(BuildContext context) {
    final config = _configs[_exercise]!;
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text("Vision Coach", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text("Camera-based rep counter and form feedback", style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 14),
          Row(
            children: ExerciseType.values.map((e) {
              final active = e == _exercise;
              return Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: ChoiceChip(
                    label: Text(_configs[e]!.label),
                    selected: active,
                    selectedColor: AppColors.mint,
                    backgroundColor: Colors.white,
                    side: const BorderSide(color: AppColors.border),
                    onSelected: (_) {
                      setState(() => _exercise = e);
                      _resetReps();
                    },
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 12),
          if (_error != null) InfoBanner.error(_error!),
          AspectRatio(
            aspectRatio: 3 / 4,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(22),
              child: Container(
                color: AppColors.ink,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (_controller != null && _controller!.value.isInitialized)
                      CameraPreview(_controller!)
                    else
                      const Center(
                        child: Padding(
                          padding: EdgeInsets.all(30),
                          child: Text(
                            'Tap "Start Camera" to begin pose analysis.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                          ),
                        ),
                      ),
                    if (_running)
                      Positioned(
                        left: 12,
                        right: 12,
                        bottom: 12,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                          child: Text(
                            _feedback.isEmpty ? "Get in frame to begin" : _feedback,
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          MintButton(label: _running ? "Stop Camera" : "Start Camera", onPressed: _running ? _stop : _start),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text("⇄ Reps", style: TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Text("$_reps", style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text("∠ Angle", style: TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Text("${_angle.round()} deg", style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
            ),
          ]),
          const SizedBox(height: 10),
          OutlineButton(label: "Reset rep count", onPressed: _resetReps),
          const SizedBox(height: 4),
          Text('Tracking: ${config.label}', style: const TextStyle(color: AppColors.muted, fontSize: 11)),
        ],
      ),
    );
  }
}
