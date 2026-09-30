import 'dart:convert';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';

class EquipmentScanScreen extends StatefulWidget {
  final bool mergeIntoProfile;
  final bool returnDetections;
  const EquipmentScanScreen({super.key, this.mergeIntoProfile = false, this.returnDetections = false});

  @override
  State<EquipmentScanScreen> createState() => _EquipmentScanScreenState();
}

class _EquipmentScanScreenState extends State<EquipmentScanScreen> {
  CameraController? _controller;
  bool _initializing = true;
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _result;

  @override
  void initState() {
    super.initState();
    _initCamera();
  }

  Future<void> _initCamera() async {
    try {
      final cameras = await availableCameras();
      final camera = cameras.firstWhere((c) => c.lensDirection == CameraLensDirection.back, orElse: () => cameras.first);
      final controller = CameraController(camera, ResolutionPreset.medium, enableAudio: false);
      await controller.initialize();
      if (!mounted) return;
      setState(() {
        _controller = controller;
        _initializing = false;
      });
    } catch (e) {
      setState(() {
        _error = "Couldn't start the camera: $e";
        _initializing = false;
      });
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _capture() async {
    if (_controller == null || _busy) return;
    setState(() => _busy = true);
    try {
      final file = await _controller!.takePicture();
      final bytes = await file.readAsBytes();
      final base64Image = base64Encode(bytes);
      final result = await ApiClient.instance.post("/equipment/detect", {"imageBase64": base64Image});
      setState(() => _result = result);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = "Detection failed: $e");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _useDetection(List<String> names) async {
    if (widget.returnDetections) {
      Navigator.of(context).pop(names);
      return;
    }
    if (widget.mergeIntoProfile) {
      setState(() => _busy = true);
      try {
        final current = await ApiClient.instance.get("/equipment/user/equipment");
        final currentNames = (current as List).map((e) => e["name"] as String).toSet();
        currentNames.addAll(names);
        await ApiClient.instance.post("/equipment/user/equipment", {"equipmentNames": currentNames.toList()});
        if (!mounted) return;
        Navigator.of(context).pop();
      } catch (e) {
        setState(() => _error = "Couldn't save equipment: $e");
      } finally {
        if (mounted) setState(() => _busy = false);
      }
    } else {
      Navigator.of(context).pop(names);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Scan equipment")),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error != null) InfoBanner.error(_error!),
                if (_result == null) ...[
                  SizedBox(
                    height: 400,
                    width: double.infinity,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(22),
                      child: Container(
                        color: AppColors.ink,
                        child: _initializing
                            ? const Center(child: CircularProgressIndicator(color: Colors.white))
                            : (_controller != null
                                ? Center(child: CameraPreview(_controller!))
                                : const Center(child: Text("Camera unavailable", style: TextStyle(color: Colors.white)))),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  MintButton(label: "Capture", loading: _busy, onPressed: _controller == null ? null : _capture),
                ] else
                  _buildResult(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildResult() {
    final result = _result!;
    if (result["configured"] == false) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InfoBanner.info(result["message"]),
          const SizedBox(height: 10),
          OutlineButton(label: "Try again", onPressed: () => setState(() => _result = null)),
        ],
      );
    }

    final detections = (result["detections"] as List?) ?? [];
    if (detections.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InfoBanner.info(result["message"] ?? "No equipment recognized — try a clearer photo."),
          const SizedBox(height: 10),
          OutlineButton(label: "Try again", onPressed: () => setState(() => _result = null)),
        ],
      );
    }

    final names = detections.map<String>((d) => d["equipmentName"] as String).toSet().toList();
    final suggestions = (result["suggestedExercises"] as List?) ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text("Detected equipment", style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: detections
                    .map<Widget>((d) => Chip(
                          label: Text("${d["equipmentName"]} · ${((d["confidence"] as num) * 100).round()}%"),
                          backgroundColor: AppColors.mint,
                        ))
                    .toList(),
              ),
              const SizedBox(height: 12),
              MintButton(label: "Use this equipment", loading: _busy, onPressed: () => _useDetection(names)),
            ],
          ),
        ),
        if (suggestions.isNotEmpty)
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("Suggested exercises with this equipment", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                for (final ex in suggestions)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(ex["name"], style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                        Text("${ex["primaryMuscle"]} · ${ex["sets"]} sets × ${ex["repRangeLow"]}-${ex["repRangeHigh"]} reps",
                            style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                        Text(ex["howTo"], style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        OutlineButton(label: "Scan again", onPressed: () => setState(() => _result = null)),
      ],
    );
  }
}
