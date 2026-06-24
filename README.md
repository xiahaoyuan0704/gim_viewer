using Parabox.Stl;
using SevenZip;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Xml;
using UnityEngine;
using UnityEngine.ProBuilder.MeshOperations;
using UnityEngine.ProBuilder;
using Debug = UnityEngine.Debug;
using System.Collections;
using System.Globalization;
using MeshMakerNamespace;
using UnityEngine.Events;

namespace cn.cssoftstudio.gimParser
{
    public class GimParser : MonoBehaviour
    {
		public UnityEvent onParseFinished;
        public string gimFilePath;
		public int smooth = 20;
		[Header("Advanced")]
		[Tooltip("Boolean CSG operations can trigger stack overflow on complex/invalid models. Keep disabled for stability.")]
		public bool enableBooleanCsg = false;
		[Tooltip("Enable verbose parser debug logs (matrix parsing, property resolving and skipped invalid entries).")]
		public bool enableDebugLogs = false;
		[Tooltip("Use lightweight colliders for picking to improve performance on very large models.")]
		public bool useLightweightPickCollider = true;
		[Tooltip("Meshes with vertex count above this threshold will use BoxCollider instead of MeshCollider when lightweight mode is enabled.")]
		public int meshColliderVertexThreshold = 4000;

		private string dir;
        private string dirCBM;
        private string dirDEV;
        private string dirPHM;
        private string dirMOD;
        private GimFileInfo gimFileInfo;
        private GameObject root;
		private Dictionary<Color, Material> matDic = new Dictionary<Color, Material>();
		private List<ProBuilderMesh> proBuilderMeshes = new List<ProBuilderMesh>(20);
		private Dictionary<string, ProBuilderMesh> proBuilderMeshDic = new Dictionary<string, ProBuilderMesh>(20);
		private List<ProBuilderMesh> proBuilderMeshes2 = new List<ProBuilderMesh>(20);
		private List<ProBuilderMesh> proBuilderMeshes3 = new List<ProBuilderMesh>(20);
		private readonly HashSet<string> parsingDevStack = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

		private int extractionFinishedInvoked = 0;

		private void LogDebug(string message)
		{
			if (!enableDebugLogs)
			{
				return;
			}
			Debug.Log($"[GimParserDebug] {message}");
		}

		private static string _Ifc2XbimUrl
		{
			get
			{
				return Path.Combine(Application.streamingAssetsPath, "ifc2xbim/ifc2xbim.exe");
			}
		}

		async void Start()
        {
			/*ProBuilderMesh proBuilderMesh1 = ShapeGenerator.GenerateTorus(PivotLocation.Center, 16, 24, 1, 0.1f, true, 360, 360, false);
			proBuilderMesh1.ToMesh();
			proBuilderMesh1.Refresh();
			proBuilderMesh1.GetComponent<MeshRenderer>().material = GetMaterialByColor(Color.blue);

			ProBuilderMesh proBuilderMesh2 = ShapeGenerator.GenerateTorus(PivotLocation.Center, 16, 24, 1, 0.1f, true, 90, 360, false);
			proBuilderMesh2.ToMesh();
			proBuilderMesh2.Refresh();
			proBuilderMesh2.GetComponent<MeshRenderer>().material = GetMaterialByColor(Color.red);
			var pivot = new GameObject();
			proBuilderMesh2.transform.SetParent(pivot.transform, true);
			proBuilderMesh2.SetPivot(Vector3.zero);*/

			/*var vertices = new List<Vector3>() { new Vector3(0, -0.2f, 0) };
			for (int angle = 0; angle <= 90; angle += 10)
			{
				vertices.Add(new Vector3(1.2f * Mathf.Cos(angle * Mathf.Deg2Rad), -0.2f, 1.2f * Mathf.Sin(angle * Mathf.Deg2Rad)));
			}
			var proBuilderMesh2 = ProBuilderMesh.Create();
			proBuilderMesh2.CreateShapeFromPolygon(vertices, 0, false);

			proBuilderMesh2.DuplicateAndFlip(proBuilderMesh2.faces.ToArray());
			proBuilderMesh2.Extrude(new Face[] { proBuilderMesh2.faces[0] }, ExtrudeMethod.IndividualFaces, 0.4f);
			proBuilderMesh2.ToMesh();
			proBuilderMesh2.Refresh();
			proBuilderMesh2.GetComponent<MeshRenderer>().material = GetMaterialByColor(Color.red);
			MeshUtility.CollapseSharedVertices(proBuilderMesh2.GetComponent<MeshFilter>().sharedMesh);

			var mesh = CSG.Subtract(proBuilderMesh1.gameObject, proBuilderMesh2.gameObject, true, true);

			MeshUtility.CollapseSharedVertices(mesh);
			var p = ProBuilderMesh.Create();
			var meshImporter = new MeshImporter(mesh, new Material[] { GetMaterialByColor(Color.green) }, p);
			meshImporter.Import();
			p.ToMesh();
			p.Refresh();
			p.GetComponent<MeshRenderer>().material = GetMaterialByColor(Color.green);*/

			//var p = CreateRing(1, 0.1f, 90);
			//p.GetComponent<MeshRenderer>().material = GetMaterialByColor(Color.green);
			//await ParseGim();
			//StartCoroutine(ParseModFile("E:/lbdev/gim-parser/孝昌联建110kV变电站新建工程/MOD/6b9223a8-ecba-407d-81ac-a0d6ab1699a1-0022a871.mod", new GameObject(), Matrix4x4.identity));
		}

		private ProBuilderMesh CreateRing(float innerRadius, float outerRadius, float arc)
		{
			ProBuilderMesh proBuilderMesh1 = ShapeGenerator.GenerateTorus(PivotLocation.Center, 16, 24, innerRadius, outerRadius, true, arc, 360, false);
			proBuilderMesh1.ToMesh();
			proBuilderMesh1.Refresh();
			proBuilderMesh1.SetPivot(Vector3.zero);
			return proBuilderMesh1;
		}

		public GameObject Model
		{
			get
			{
				return root;
			}
		}

		public bool TryGetProperties(Transform target, out Dictionary<string, string> properties)
		{
			properties = null;
			if (target == null)
			{
				return false;
			}
			var current = target;
			var result = new Dictionary<string, string>();
			var visitedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			while (current != null)
			{
				var property = current.GetComponent<GimProperty>();
				if (property != null)
				{
					if (property.filePaths.Count > 0)
					{
						foreach (var file in property.filePaths)
						{
							if (string.IsNullOrWhiteSpace(file) || !visitedFiles.Add(file))
							{
								continue;
							}
							var item = ReadPropertyFile(file);
							if (item == null)
							{
								continue;
							}
							foreach (var kv in item)
							{
								AddPropertyEntry(result, kv.Key, kv.Value);
							}
						}
					}
					else if (!string.IsNullOrEmpty(property.filePath))
					{
						if (!visitedFiles.Add(property.filePath))
						{
							current = current.parent;
							continue;
						}
						var item = ReadPropertyFile(property.filePath);
						if (item != null)
						{
							foreach (var kv in item)
							{
								AddPropertyEntry(result, kv.Key, kv.Value);
							}
						}
					}
				}
				current = current.parent;
			}
			if (result.Count > 0)
			{
				properties = result;
				return true;
			}
			return false;
		}

		public void Clear()
		{
			if (root != null)
			{
				Destroy(root);
				root = null;
			}
		}

        public async Task ParseGim()
        {
            extractionFinishedInvoked = 0;
			parsingDevStack.Clear();

			var sevenZipDllPath = ResolveSevenZipDllPath();
			if (string.IsNullOrEmpty(sevenZipDllPath))
			{
				Debug.LogError("未找到7z.dll，无法解压GIM。请确认打包目录包含 *_Data/Plugins/x86_64/7z.dll 或与exe同目录的7z.dll。");
				return;
			}
			SevenZipBase.SetLibraryPath(sevenZipDllPath);

            if (!Directory.Exists(dir))
            {
				await DeCompressGim();
			}
            
            if (dir != null && Directory.Exists(dir))
            {
				//Directory.Delete(dir, true);
				StartCoroutine(ParseDataFiles());
            }
			else
			{
				Debug.LogError($"GIM解压目录不存在或不可访问: {dir}");
			}
        }

		private string ResolveSevenZipDllPath()
		{
			var candidates = new List<string>();
			candidates.Add(Path.Combine(Application.dataPath, "Plugins", "x86_64", "7z.dll"));
			candidates.Add(Path.Combine(Path.GetDirectoryName(Application.dataPath), "7z.dll"));
			candidates.Add(Path.Combine(Application.streamingAssetsPath, "7-Zip", "7z.dll"));
			foreach (var path in candidates)
			{
				if (File.Exists(path))
				{
					LogDebug($"Use 7z.dll: {path}");
					return path;
				}
			}
			return null;
		}

        private IEnumerator ParseDataFiles()
        {
			CreateRootIfNeeded();
			if (!Directory.Exists(dirCBM))
			{
				yield return ParseWithoutCbm();
			}
			else
            {
				var projPath = Path.Combine(dirCBM, "project.cbm");
				if (File.Exists(projPath))
				{
					string[] lines = null;
					yield return Task.Run(() => {
						lines = File.ReadAllLines(projPath);
					});
					Debug.LogFormat("parse file: {0}", projPath);
					for (int i = 0; i < lines.Length; i++)
					{
						var line = lines[i];
						var segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						var k = segments[0].Trim();
						var v = segments[1].Trim();
						if (k.Equals("SUBSYSTEM"))
						{
							var path = Path.Combine(dirCBM, v);
							yield return ParseCbmFile(path, 1, root);
						}
					}
					Debug.LogFormat("完成");
				}
				else
				{
					var files = Directory.GetFiles(dirCBM, "*.cbm");
					if (files.Length == 1)
					{
						yield return ParseCbmFile(files[0], 1, root);
					}
					else
					{
						yield return ParseWithoutCbm();
					}
				}
			}
			if (root != null)
			{
				root.transform.localRotation = Quaternion.Euler(-90, 0, 0);
				EnsureSelectableColliders(root);
			}
			//AsciiFBXExporter.FBXExporter.ExportGameObjAtRuntime(root, "E:\\lbdev\\gim-parser\\export\\byq.fbx");
			//AsciiFBXExporter.FBXExporter.ExportGameObjAtRuntime(root, "E:\\lbdev\\gim-parser\\export\\", "byq.fbx", "textures", true);
			onParseFinished.Invoke();
		}

		private Dictionary<string, string> ReadPropertyFile(string propertyFile)
		{
			if (string.IsNullOrWhiteSpace(propertyFile))
			{
				return null;
			}
			var candidates = new List<string>();
			if (Path.IsPathRooted(propertyFile))
			{
				candidates.Add(propertyFile);
			}
			if (!string.IsNullOrEmpty(dirCBM))
			{
				candidates.Add(Path.Combine(dirCBM, propertyFile));
			}
			if (!string.IsNullOrEmpty(dirDEV))
			{
				candidates.Add(Path.Combine(dirDEV, propertyFile));
			}
			if (!string.IsNullOrEmpty(dirPHM))
			{
				candidates.Add(Path.Combine(dirPHM, propertyFile));
			}
			if (!string.IsNullOrEmpty(dirMOD))
			{
				candidates.Add(Path.Combine(dirMOD, propertyFile));
			}
			if (!string.IsNullOrEmpty(dir))
			{
				candidates.Add(Path.Combine(dir, propertyFile));
			}
			foreach (var path in candidates)
			{
				if (!File.Exists(path))
				{
					continue;
				}
				LogDebug($"ReadPropertyFile hit: {path}");
				var map = new Dictionary<string, string>();
				var lines = File.ReadAllLines(path);
				foreach (var line in lines)
				{
					if (TryParsePropertyLine(line, out var key, out var value))
					{
						map[key] = value;
					}
				}
				return map;
			}
			return null;
		}

		private static void AddPropertyEntry(Dictionary<string, string> map, string key, string value)
		{
			if (string.IsNullOrWhiteSpace(key))
			{
				return;
			}
			var normalizedKey = key.Trim();
			var normalizedValue = value == null ? string.Empty : value.Trim();
			if (!map.ContainsKey(normalizedKey))
			{
				map[normalizedKey] = normalizedValue;
				return;
			}
			var i = 2;
			var alias = $"{normalizedKey}#{i}";
			while (map.ContainsKey(alias))
			{
				i++;
				alias = $"{normalizedKey}#{i}";
			}
			map[alias] = normalizedValue;
		}

		private static bool TryParsePropertyLine(string line, out string key, out string value)
		{
			key = null;
			value = null;
			if (string.IsNullOrWhiteSpace(line))
			{
				return false;
			}
			var trimmed = line.Trim();
			var firstEq = trimmed.IndexOf('=');
			if (firstEq <= 0 || firstEq >= trimmed.Length - 1)
			{
				return false;
			}

			var left = trimmed.Substring(0, firstEq).Trim();
			var right = trimmed.Substring(firstEq + 1).Trim();
			if (string.IsNullOrEmpty(left))
			{
				return false;
			}

			var secondEq = right.IndexOf('=');
			if (secondEq > 0)
			{
				var middle = right.Substring(0, secondEq).Trim();
				var tail = right.Substring(secondEq + 1).Trim();
				if (int.TryParse(left, out _) && !string.IsNullOrEmpty(middle))
				{
					key = middle;
					value = tail;
					return true;
				}
			}

			key = left;
			value = right;
			return true;
		}

		private static bool TryParseMatrix(string csv, out Matrix4x4 matrix)
		{
			matrix = Matrix4x4.identity;
			if (string.IsNullOrWhiteSpace(csv))
			{
				return false;
			}
			var comps = csv.Split(",");
			if (comps.Length < 16)
			{
				return false;
			}
			var values = new float[16];
			for (var i = 0; i < 16; i++)
			{
				if (!float.TryParse(comps[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
				{
					return false;
				}
				if (float.IsNaN(parsed) || float.IsInfinity(parsed))
				{
					return false;
				}
				values[i] = parsed;
			}
			matrix = new Matrix4x4(
				new Vector4(values[0], values[1], values[2], values[3]),
				new Vector4(values[4], values[5], values[6], values[7]),
				new Vector4(values[8], values[9], values[10], values[11]),
				new Vector4(values[12], values[13], values[14], values[15]));

			var t = matrix.GetT();
			if (float.IsNaN(t.x) || float.IsNaN(t.y) || float.IsNaN(t.z))
			{
				return false;
			}
			return true;
		}

		private bool TryParseMatrixWithDebug(string csv, string context, out Matrix4x4 matrix)
		{
			var ok = TryParseMatrix(csv, out matrix);
			if (!ok)
			{
				LogDebug($"Invalid matrix skipped at {context}. raw='{csv}'");
			}
			return ok;
		}

		private void EnsureSelectableColliders(GameObject modelRoot)
		{
			var meshFilters = modelRoot.GetComponentsInChildren<MeshFilter>(true);
			foreach (var meshFilter in meshFilters)
			{
				if (meshFilter.sharedMesh == null)
				{
					continue;
				}
				var go = meshFilter.gameObject;
				var mesh = meshFilter.sharedMesh;
				if (useLightweightPickCollider && mesh.vertexCount > meshColliderVertexThreshold)
				{
					var meshCollider = go.GetComponent<MeshCollider>();
					if (meshCollider != null)
					{
						Destroy(meshCollider);
					}
					var boxCollider = go.GetComponent<BoxCollider>();
					if (boxCollider == null)
					{
						boxCollider = go.AddComponent<BoxCollider>();
					}
					boxCollider.center = mesh.bounds.center;
					boxCollider.size = mesh.bounds.size;
					continue;
				}

				var collider = go.GetComponent<MeshCollider>();
				if (collider == null)
				{
					collider = go.AddComponent<MeshCollider>();
				}
				collider.sharedMesh = mesh;
			}
		}

		private void CreateRootIfNeeded()
		{
			if (root != null)
			{
				return;
			}
			root = new GameObject();
			if (!string.IsNullOrEmpty(gimFileInfo?.fileName))
			{
				root.name = gimFileInfo.fileName;
			}
			else
			{
				var fileInfo = new FileInfo(gimFilePath);
				root.name = fileInfo.Name.Substring(0, fileInfo.Name.Length - fileInfo.Extension.Length);
			}
		}

		private IEnumerator ParseWithoutCbm()
		{
			if (!Directory.Exists(dirDEV))
			{
				Debug.LogWarning("设备模型文件损坏（缺少CBM且DEV目录不存在）");
				yield break;
			}
			var devFiles = Directory.GetFiles(dirDEV, "*.dev", SearchOption.TopDirectoryOnly);
			if (devFiles.Length == 0)
			{
				Debug.LogWarning("设备模型文件损坏（缺少CBM且没有可解析的DEV文件）");
				yield break;
			}
			var referencedSubDevs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			foreach (var devFile in devFiles)
			{
				var lines = File.ReadAllLines(devFile);
				foreach (var line in lines)
				{
					var parts = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
					if (parts.Length < 2)
					{
						continue;
					}
					var key = parts[0].Trim();
					if (key.StartsWith("SUBDEVICE", StringComparison.OrdinalIgnoreCase))
					{
						referencedSubDevs.Add(parts[1].Trim());
					}
				}
			}
			var rootDevFiles = new List<string>();
			foreach (var devFile in devFiles)
			{
				var fileName = Path.GetFileName(devFile);
				if (!referencedSubDevs.Contains(fileName))
				{
					rootDevFiles.Add(devFile);
				}
			}
			if (rootDevFiles.Count == 0)
			{
				rootDevFiles.AddRange(devFiles);
			}
			Debug.LogWarning($"未找到有效CBM，切换到DEV直解析模式，根设备数量: {rootDevFiles.Count}");
			foreach (var devFile in rootDevFiles)
			{
				yield return ParseDevFile(devFile, root, Matrix4x4.identity);
			}
		}

		private IEnumerator ParseCbmFile(string path, int level, GameObject parent)
        {
            var obj = new GameObject();
			obj.transform.SetParent(parent.transform, false);
			var objProperty = obj.AddComponent<GimProperty>();
			objProperty.AddFilePath(path);

			string[] lines = File.ReadAllLines(path);
			Debug.LogFormat("parse file: {0}", path);

			var i = 0;
			var nameParts = new List<string>();
			while (i <= lines.Length - 1)
			{
				var line = lines[i];
				var segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
				var k = segments[0].Trim();
				string v = "";
				if (segments.Length > 1)
				{
					v = segments[1].Trim();
				}
				if (k.Equals("ENTITYNAME"))
				{
					//obj.name = v;
					nameParts.Add(v);
				}
				else if (k.Equals("SYSCLASSIFYNAME"))
				{
					nameParts.Add(v);
				}
				else if (k.Equals("BASEFAMILY"))
				{
					objProperty.AddFilePath(v);
				}
				else if (k.Equals("SYSTEMNAME1")) //三级子系统（子区域）- 系统名称
				{
					//TODO
				}
				else if (k.Equals("SYSTEMNAME2"))//三级子系统（子区域）- 系统名称
				{
					//TODO
				}
				else if (k.Equals("SYSTEMNAME3"))//三级子系统（子区域）- 系统名称
				{
					//TODO
				}
				else if (k.Equals("BASEFAMILY1"))//三级子系统（子区域）- 系统属性文件
				{
					//TODO
				}
				else if (k.Equals("BASEFAMILY2"))//三级子系统（子区域）- 系统属性文件
				{
					//TODO
				}
				else if (k.Equals("BASEFAMILY3"))//三级子系统（子区域）- 系统属性文件
				{
					//TODO
				}
				else if (k.Equals("SUBSYSTEMS.NUM"))
				{
					var len = int.Parse(v);
					for (int j = i + 1; j <= len + i; j++)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();
						yield return ParseCbmFile(Path.Combine(dirCBM, v), level + 1, obj);
					}

					i += len;
				}
				else if (k.Equals("SCH.NUM")) //逻辑模型
				{
					//TODO
				}
				else if (k.Equals("IFC.NUM"))
				{
					var len = int.Parse(v);
					for (int j = i + 1; j <= len + i; j++)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();
						yield return ParseIfc(Path.Combine(dirCBM, v), obj);
					}
					i += len;
				}
				else if (k.Equals("IFCFILE")) //二级系统（区域）、三级子系统（子区域）、四级设备（设施）
				{
					//TODO
				}
				else if (k.Equals("IFCGUID")) //二级系统（区域）、三级子系统（子区域）、四级设备（设施）
				{
					//TODO
				}
				else if (k.Equals("MATERIALSHEET"))
				{
					//TODO
				}
				else if (k.Equals("TRANSFORMMATRIX")) //四级设备（设施）- 相对变电站原点的空间变换矩阵
				{
					if (TryParseMatrixWithDebug(v, $"CBM TRANSFORMMATRIX file={path}", out var matrix))
					{
						obj.transform.localPosition = matrix.GetT();
						obj.transform.localRotation = matrix.GetR();
						obj.transform.localScale = matrix.GetS();
					}
				}
				else if (level < 5 && k.Equals("OBJECTMODELPOINTER")) //四级设备（设施）- dev文件引用
				{
					yield return ParseDevFile(Path.Combine(dirDEV, v), obj, Matrix4x4.identity);
				}
				else if (k.Equals("SUBDEVICES.NUM")) //四级设备（设施）- 部件数量 - 仅用于为部件赋予工程属性，不用于渲染
				{
					var len = int.Parse(v);
					for (int j = i + 1; j <= len + i; j++)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();
						yield return ParseCbmFile(Path.Combine(dirCBM, v), level + 1, obj);
					}
					i += len;
				}
				else if (k.Equals("PARTNAME")) //四级设备（设施）- 部件名称
				{
					nameParts.Add(v);
				}
				i++;
			}
			nameParts.Add(Path.GetFileName(path));
			obj.name = string.Join("-", nameParts);

			/*if (GimFileFlag.GIMPKGS.ToString().Equals(gimFileInfo.fileFlag))
            {
                
            }
            else if (GimFileFlag.GIMPKGT.ToString().Equals(gimFileInfo.fileFlag))
            {

            }
            else if (GimFileFlag.GIMPKEC.ToString().Equals(gimFileInfo.fileFlag))
            {

            }*/
		}

		private IEnumerator ParseDevFile(string path, GameObject parent, Matrix4x4 mat)
		{
			var normalizedPath = Path.GetFullPath(path).Replace("\\", "/");
			if (!parsingDevStack.Add(normalizedPath))
			{
				Debug.LogWarning($"检测到循环DEV引用，跳过: {path}");
				yield break;
			}

			var obj = new GameObject();
			obj.transform.SetParent(parent.transform, false);
			obj.transform.localPosition = mat.GetT();
			obj.transform.localRotation = mat.GetR();
			obj.transform.localScale = mat.GetS();
			var objProperty = obj.AddComponent<GimProperty>();
			objProperty.AddFilePath(path);

			string[] lines = File.ReadAllLines(path);
			Debug.LogFormat("parse file: {0}", path);

			var i = 0;
			var nameParts = new List<string>();
			while (i <= lines.Length - 1)
			{
				var line = lines[i];
				var segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
				var k = segments[0].Trim();
				string v = "";
				if (segments.Length > 1)
				{
					v = segments[1].Trim();
				}
				if (k.Equals("SYMBOLNAME"))
				{
					nameParts.Add(v);
				}
				else if (k.Equals("TYPE"))
				{
					nameParts.Add(v);
				}
				else if (k.Equals("BASEFAMILY") || k.Equals("BASEFAMILYPOINTER"))
				{
					objProperty.AddFilePath(v);
				}
				else if (k.Equals("SUBDEVICES.NUM")) //引用的dev文件数量
				{
					var len = int.Parse(v) * 2; // 每一个dev模型有2行数据，分别是模型文件、空间矩阵
					for (int j = i + 1; j <= len + i; j += 2)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();

						var lineMat = lines[j + 1].Trim();
						var lineMatSegments = lineMat.Split("=", StringSplitOptions.RemoveEmptyEntries);
						if (TryParseMatrixWithDebug(lineMatSegments[1], $"DEV SUBDEVICE matrix file={path} target={v}", out var matDev))
						{
							yield return ParseDevFile(Path.Combine(dirDEV, v), obj, matDev);
						}
					}
					i += len;
				}
				else if (k.Equals("SOLIDMODELS.NUM")) //引用的phm文件数量
				{
					var len = int.Parse(v) * 2;
					for (int j = i + 1; j <= len + i; j += 2)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();

						var lineMat = lines[j + 1].Trim();
						var lineMatSegments = lineMat.Split("=", StringSplitOptions.RemoveEmptyEntries);
						if (TryParseMatrixWithDebug(lineMatSegments[1], $"DEV SOLIDMODEL matrix file={path} target={v}", out var matPhm))
						{
							yield return ParsePhmFile(Path.Combine(dirPHM, v), obj, matPhm);
						}
					}
					i += len;
				}
				else if (k.Equals("TRANSFORMMATRIX"))
				{
					/*string[] comps = v.Split(",");
					var m4 = new Matrix4x4(new Vector4(float.Parse(comps[0]), float.Parse(comps[1]), float.Parse(comps[2]), float.Parse(comps[3])), new Vector4(float.Parse(comps[4]), float.Parse(comps[5]), float.Parse(comps[6]), float.Parse(comps[7])), new Vector4(float.Parse(comps[8]), float.Parse(comps[9]), float.Parse(comps[10]), float.Parse(comps[11])), new Vector4(float.Parse(comps[12]), float.Parse(comps[13]), float.Parse(comps[14]), float.Parse(comps[15])));
					obj.transform.position = m4.GetT();
					obj.transform.rotation = m4.GetR();
					obj.transform.localScale = m4.GetS();*/
					Debug.LogError(string.Format("dev file ({0}) has single TRANSFORMMATRIX", path));
				}
				i++;
			}
			nameParts.Add(Path.GetFileName(path));
			obj.name = string.Join("-", nameParts);
			parsingDevStack.Remove(normalizedPath);
		}

		private IEnumerator ParsePhmFile(string path, GameObject parent, Matrix4x4 mat)
		{
			var obj = new GameObject();
			obj.transform.SetParent(parent.transform, false);
			obj.transform.localPosition = mat.GetT();
			obj.transform.localRotation = mat.GetR();
			obj.transform.localScale = mat.GetS();
			var objProperty = obj.AddComponent<GimProperty>();
			objProperty.AddFilePath(path);

			string[] lines = File.ReadAllLines(path);
			Debug.LogFormat("parse file: {0}", path);

			var i = 0;
			var nameParts = new List<string>();
			while (i <= lines.Length - 1)
			{
				var line = lines[i];
				var segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
				var k = segments[0].Trim();
				string v = "";
				if (segments.Length > 1)
				{
					v = segments[1].Trim();
				}
				if (k.Equals("SOLIDMODELS.NUM")) //引用的phm/mod/stl文件数量
				{
					var len = int.Parse(v) * 3; //每一个phm模型有三行数据，分别是模型文件、空间矩阵、颜色值
					for (int j = i + 1; j <= len + i; j += 3)
					{
						line = lines[j];
						segments = line.Split("=", StringSplitOptions.RemoveEmptyEntries);
						v = segments[1].Trim();
						var ext = Path.GetExtension(v).ToUpper();

						var lineMat = lines[j + 1].Trim();
						var lineMatSegments = lineMat.Split("=", StringSplitOptions.RemoveEmptyEntries);
						if (!TryParseMatrixWithDebug(lineMatSegments[1], $"PHM SOLIDMODEL matrix file={path} target={v}", out var matPhm))
						{
							continue;
						}
						if (ext.Equals(".PHM"))
						{
							yield return ParsePhmFile(Path.Combine(dirPHM, v), obj, matPhm);
						}
						else if (ext.Equals(".MOD"))
						{
							yield return ParseModFile(Path.Combine(dirMOD, v), obj, matPhm);
						}
						else if (ext.Equals(".STL"))
						{
							var lineColor = lines[j + 2].Trim();
							var lineColorSegments = lineColor.Split("=", StringSplitOptions.RemoveEmptyEntries);
							string[] colorComps = lineColorSegments[1].Split(",");
							var color = new Color(float.Parse(colorComps[0]) / 255, float.Parse(colorComps[1]) / 255, float.Parse(colorComps[2]) / 255, 0);
							yield return ParseStlFile(Path.Combine(dirMOD, v), obj, matPhm, color);
						}
					}
					i += len;
				}
				else if (k.Equals("TRANSFORMMATRIX"))
				{
					/*string[] comps = v.Split(",");
					var m4 = new Matrix4x4(new Vector4(float.Parse(comps[0]), float.Parse(comps[1]), float.Parse(comps[2]), float.Parse(comps[3])), new Vector4(float.Parse(comps[4]), float.Parse(comps[5]), float.Parse(comps[6]), float.Parse(comps[7])), new Vector4(float.Parse(comps[8]), float.Parse(comps[9]), float.Parse(comps[10]), float.Parse(comps[11])), new Vector4(float.Parse(comps[12]), float.Parse(comps[13]), float.Parse(comps[14]), float.Parse(comps[15])));
					obj.transform.position = m4.GetT();
					obj.transform.rotation = m4.GetR();
					obj.transform.localScale = m4.GetS();*/
					Debug.LogError(string.Format("phm file ({0}) has single TRANSFORMMATRIX", path));
				}
				else if (k.Equals("COLOR"))
				{
					Debug.LogError(string.Format("phm file ({0}) has single COLOR", path));
				}
				i++;
			}
			nameParts.Add(Path.GetFileName(path));
			obj.name = string.Join("-", nameParts);
		}

		private IEnumerator ParseStlFile(string path, GameObject parent, Matrix4x4 matrix, Color color)
		{
			var meshes = Importer.Import(path, CoordinateSpace.Left, UpAxis.Z).ToArray();
			Material mat = GetMaterialByColor(color);
			foreach (var item in meshes)
			{
				var go = new GameObject();
				go.name = Path.GetFileName(path);
				go.transform.SetParent(parent.transform, false);
				go.transform.localPosition = matrix.GetT();
				go.transform.localRotation = matrix.GetR();
				go.transform.localScale = matrix.GetS();
				go.AddComponent<MeshFilter>().mesh = item;
				go.AddComponent<MeshRenderer>().material = mat;
				go.AddComponent<MeshCollider>().sharedMesh = item;
			}
			yield return null;
		}

		private IEnumerator ParseModFile(string path, GameObject parent, Matrix4x4 matrix)
		{
			proBuilderMeshes.Clear();
			proBuilderMeshDic.Clear();
			XmlDocument xmlObj = new XmlDocument();
			xmlObj.Load(path);
			XmlNode docRoot = xmlObj.DocumentElement;
			XmlNodeList entityNodes = docRoot.SelectNodes("Entities/Entity");
			var hidenObjs = new Dictionary<string, ProBuilderMesh>(entityNodes.Count);
			foreach (XmlNode entityNode in entityNodes)
			{
				string id = entityNode.Attributes["ID"].Value;
				string type = entityNode.Attributes["Type"].Value;
				string visible = entityNode.Attributes["Visible"].Value;
				//   ȡColor ڵ      ֵ
				XmlNode colorNode = entityNode.SelectSingleNode("Color");
				string red = colorNode.Attributes["R"].Value;
				string green = colorNode.Attributes["G"].Value;
				string blue = colorNode.Attributes["B"].Value;
				string alpha = colorNode.Attributes["A"].Value;
				var color = new Color(float.Parse(red) / 255, float.Parse(green) / 255, float.Parse(blue) / 255, float.Parse(alpha)); //     RGBA  ɫֵ
				var mat = GetMaterialByColor(color);
				//   ȡStretchedBody ڵ      ֵ
				XmlNode TransformMatrix = entityNode.SelectSingleNode("TransformMatrix");
				XmlNode TerminalBlock = entityNode.SelectSingleNode("TerminalBlock");
				XmlNode Cylinder = entityNode.SelectSingleNode("Cylinder");
				XmlNode stretchedBodyNode = entityNode.SelectSingleNode("StretchedBody");
				XmlNode Cuboid = entityNode.SelectSingleNode("Cuboid");
				XmlNode Ring = entityNode.SelectSingleNode("Ring");
				XmlNode TruncatedCone = entityNode.SelectSingleNode("TruncatedCone");
				XmlNode PorcelainBushing = entityNode.SelectSingleNode("PorcelainBushing");
				XmlNode Sphere = entityNode.SelectSingleNode("Sphere");
				XmlNode Wire = entityNode.SelectSingleNode("Wire");
				XmlNode Insulator = entityNode.SelectSingleNode("Insulator");
				XmlNode Boolean = entityNode.SelectSingleNode("Boolean");
				XmlNode CircularGasket = entityNode.SelectSingleNode("CircularGasket");
				XmlNode OffsetRectangularTable = entityNode.SelectSingleNode("OffsetRectangularTable");
				XmlNode RotationalEllipsoid = entityNode.SelectSingleNode("RotationalEllipsoid");
				XmlNode RoundSteelTube = entityNode.SelectSingleNode("RoundSteelTube");
				XmlNode EquilateralAngleSteel = entityNode.SelectSingleNode("EquilateralAngleSteel");
				XmlNode FlatSteel = entityNode.SelectSingleNode("FlatSteel");
				var v = TransformMatrix.Attributes["Value"].Value;
				if (!TryParseMatrixWithDebug(v, $"MOD Entity Transform file={path} id={id}", out var m))
				{
					continue;
				}
				m = matrix * m;

				if (stretchedBodyNode != null)
				{
					string length = stretchedBodyNode.Attributes["L"].Value;
					string normal = stretchedBodyNode.Attributes["Normal"].Value;
					string array = stretchedBodyNode.Attributes["Array"].Value;
					string[] strings = array.Split(";");
					string[] normals = normal.Split(",");
					if (normals.Length < 3)
					{
						continue;
					}
					Vector3 vector3Normal = new Vector3(float.Parse(normals[0]), float.Parse(normals[1]), float.Parse(normals[2]));
					var points = new List<Vector3>(strings.Length);
					for (int i = 0; i < strings.Length; i++)
					{
						if (string.IsNullOrWhiteSpace(strings[i]))
						{
							continue;
						}
						string[] strings1 = strings[i].Split(",");
						if (strings1.Length < 3)
						{
							continue;
						}
						points.Add(new Vector3(float.Parse(strings1[0]), float.Parse(strings1[1]), float.Parse(strings1[2])));
					}
					if (points.Count < 3)
					{
						continue;
					}
					var vector3s = points.ToArray();
					ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();

					//proBuilderMesh.CreateShapeFromPolygon(vector3s, float.Parse(length), false);


					proBuilderMesh.CreateShapeFromPolygon(vector3s, 0f, false);

					var vertices = proBuilderMesh.GetVertices()?.ToList();
					if (vertices == null || vertices.Count == 0 || proBuilderMesh.faces == null || proBuilderMesh.faces.Count == 0)
					{
						Destroy(proBuilderMesh.gameObject);
						continue;
					}

					if (Vector3.Dot(vertices[0].normal, vector3Normal) < 0)
					{
						proBuilderMesh.faces[0].Reverse();
					}

					//proBuilderMesh.ToMesh();


					/*IList<Face> faces = proBuilderMesh.faces;
					Face[] facesFace = new Face[faces.Count];
					Face[] facesEx = new Face[1];
					for (int i = 0; i < faces.Count; i++)
					{
						facesFace[i] = faces[i];
					}
					facesEx[0] = facesFace[0];
					proBuilderMesh.DuplicateAndFlip(facesFace);
					proBuilderMesh.Extrude(facesEx, ExtrudeMethod.IndividualFaces, float.Parse(length));
					proBuilderMesh.ToMesh();
					proBuilderMesh.Refresh();*/

					proBuilderMesh.DuplicateAndFlip(proBuilderMesh.faces.ToArray());
					if (proBuilderMesh.faces.Count == 0)
					{
						Destroy(proBuilderMesh.gameObject);
						continue;
					}
					proBuilderMesh.Extrude(new Face[] { proBuilderMesh.faces[0] }, ExtrudeMethod.IndividualFaces, float.Parse(length));
					proBuilderMesh.ToMesh();
					proBuilderMesh.Refresh();

					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = mat;

					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (Cuboid != null)
				{
					float L = float.Parse(Cuboid.Attributes["L"].Value);
					float W = float.Parse(Cuboid.Attributes["W"].Value);
					float H = float.Parse(Cuboid.Attributes["H"].Value);


					ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();
					/*proBuilderMesh.CreateShapeFromPolygon(new Vector3[]
					{
						new Vector3(L/2,-W/2,0),
						new Vector3(L/2,-W/2,H),
						new Vector3(-L/2,-W/2,H),
						new Vector3(-L/2,-W/2,0)
					}, W, false);*/
					proBuilderMesh.CreateShapeFromPolygon(new Vector3[]
					{
						new Vector3(L/2,W/2,0),
						new Vector3(-L/2,W/2,0),
						new Vector3(-L/2,-W/2,0),
						new Vector3(L/2,-W/2,0)
					}, H, false);
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (TerminalBlock != null)
				{
					var L = float.Parse(TerminalBlock.Attributes["L"].Value);
					var W = float.Parse(TerminalBlock.Attributes["W"].Value);
					var T = float.Parse(TerminalBlock.Attributes["T"].Value);
					var CL = float.Parse(TerminalBlock.Attributes["CL"].Value);
					var CS = float.Parse(TerminalBlock.Attributes["CS"].Value);
					var RS = float.Parse(TerminalBlock.Attributes["RS"].Value);
					var R = float.Parse(TerminalBlock.Attributes["R"].Value);
					var CN = float.Parse(TerminalBlock.Attributes["CN"].Value);
					var RN = float.Parse(TerminalBlock.Attributes["RN"].Value);
					var BL = float.Parse(TerminalBlock.Attributes["BL"].Value);
					//var Phase = float.Parse(TerminalBlock.Attributes["Phase"].Value);
					ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
					IList<IList<Vector3>> list = new List<IList<Vector3>>();
					float cW = W / 2;
					if (CN > 1)
					{
						cW = W / (CS + 1);
					}

					float J = Mathf.Deg2Rad * (360 / smooth);
					for (int row = 0; row < RN; row++)
					{
						for (int col = 0; col < CN; col++)
						{
							Vector3 o = new Vector3();
							o.x = W / 2 - cW * (col + 1);
							o.y = -T / 2;
							o.z = BL + RS * row;
							var points = new List<Vector3>();
							for (int i = 0; i < 10; i++)
							{
								Vector3 p = new Vector3();
								p.y = -T / 2;
								p.z = R * Mathf.Cos(J * i) + o.z;
								p.x = R * Mathf.Sin(J * i) + o.x;
								points.Add(p);
							}
							list.Add(points);
						}
					}

					proBuilderMesh.CreateShapeFromPolygon(new Vector3[]
					{
					new Vector3( W / 2,-T/2, 0),
					new Vector3( W / 2,-T/2, L - CL),
					new Vector3( W / 2 - CL,-T/2, L),
					new Vector3( -W / 2 + CL,-T/2, L),
					new Vector3( -W / 2,-T/2, L - CL),
					new Vector3( -W / 2,-T/2, 0)
					}, T, false);
					proBuilderMesh.name = "TerminalBlock";

					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (Cylinder != null)
				{
					var R = float.Parse(Cylinder.Attributes["R"].Value);
					var H = float.Parse(Cylinder.Attributes["H"].Value);
					ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);

					float J = Mathf.Deg2Rad * (360 / smooth);
					var points = new List<Vector3>();
					for (int i = 0; i < smooth; i++)
					{
						Vector3 p = new Vector3();
						p.z = 0;
						p.x = R * Mathf.Cos(J * i);
						p.y = R * Mathf.Sin(J * i);
						//points.Add(m1.MultiplyPoint(p));
						points.Add(p);
					}
					proBuilderMesh.CreateShapeFromPolygon(points, H, false);


					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();

					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (Ring != null)
				{
					var R = float.Parse(Ring.Attributes["R"].Value);
					var DR = float.Parse(Ring.Attributes["DR"].Value);
					var Rad = float.Parse(Ring.Attributes["Rad"].Value);
					m = m * Matrix4x4.Rotate(Quaternion.Euler(90, 0, 0));
					/*ProBuilderMesh proBuilderMesh = ShapeGenerator.GenerateTorus(PivotLocation.Center, 16, smooth, R + DR, DR, true, *//*Rad * Mathf.Rad2Deg*//*360, 360);
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);*/

					var proBuilderMesh = CreateRing(R + DR, DR, Rad * Mathf.Rad2Deg);
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.transform.SetParent(parent.transform, false);
					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (TruncatedCone != null)
				{
					var BR = float.Parse(TruncatedCone.Attributes["BR"].Value);
					var TR = float.Parse(TruncatedCone.Attributes["TR"].Value);
					var H = float.Parse(TruncatedCone.Attributes["H"].Value);
					//m = m4 * m;
					float J = Mathf.Deg2Rad * (360 / smooth);
					var pointsR = new List<Vector3>();
					for (int i = 0; i < smooth; i++)
					{
						Vector3 p = new Vector3();
						p.z = 0;
						p.x = TR * Mathf.Cos(J * i);
						p.y = TR * Mathf.Sin(J * i);
						pointsR.Add(p);
					}
					ProBuilderMesh proBuilderMeshMin = ProBuilderMesh.Create();
					proBuilderMeshMin.gameObject.transform.SetParent(parent.transform, false);
					proBuilderMeshMin.CreateShapeFromPolygon(pointsR, 0f, false);

					ProBuilderMesh proBuilderMeshMax = ProBuilderMesh.Create();
					proBuilderMeshMax.gameObject.transform.SetParent(parent.transform, false);
					proBuilderMeshMax.CreateShapeFromPolygon(pointsR, 0f, false);
					Matrix4x4 matrix4x4S = Matrix4x4.Scale(new Vector3(BR / TR, BR / TR, 1));
					Matrix4x4 matrix4x4R = Matrix4x4.Translate(new Vector3(0, 0, H));
					Vertex[] verticesMax = proBuilderMeshMax.GetVertices();
					Vertex[] verticesMin = proBuilderMeshMax.GetVertices();
					for (int i = 0; i < verticesMax.Length; i++)
					{
						verticesMax[i].position = matrix4x4S.MultiplyPoint3x4(verticesMax[i].position);
					}
					proBuilderMeshMax.SetVertices(verticesMax);
					proBuilderMeshMax.ToMesh();
					for (int i = 0; i < verticesMin.Length; i++)
					{
						verticesMin[i].position = matrix4x4R.MultiplyPoint3x4(verticesMin[i].position);
					}
					proBuilderMeshMin.SetVertices(verticesMin);
					proBuilderMeshMin.ToMesh();
					proBuilderMeshes2.Clear();
					proBuilderMeshes2.Add(proBuilderMeshMin);
					proBuilderMeshes2.Add(proBuilderMeshMax);
					CombineMeshes.Combine(proBuilderMeshes2, proBuilderMeshMin);
					Destroy(proBuilderMeshes2[1]);
					for (int i = 0; i < smooth; i++)
					{
						Face face = proBuilderMeshMin.Bridge(proBuilderMeshMin.faces[1].edges[i], proBuilderMeshMin.faces[0].edges[i]);
						face.Reverse();
					}
					/*proBuilderMeshMin.faces[0].Reverse();*/
					proBuilderMeshMin.faces[1].Reverse();
					Destroy(proBuilderMeshMax.gameObject);
					proBuilderMeshMin.ToMesh();
					proBuilderMeshMin.Refresh();
					proBuilderMeshMin.gameObject.transform.localPosition = m.GetT();
					proBuilderMeshMin.gameObject.transform.localRotation = m.GetR();
					proBuilderMeshMin.gameObject.transform.localScale = m.GetS();
					proBuilderMeshMin.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMeshMin.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMeshMin);
					proBuilderMeshDic.Add(id, proBuilderMeshMin);
				}
				else if (PorcelainBushing != null)
				{
					var R1 = float.Parse(PorcelainBushing.Attributes["R1"].Value);
					var R2 = float.Parse(PorcelainBushing.Attributes["R2"].Value);
					var R = float.Parse(PorcelainBushing.Attributes["R"].Value);
					var H = float.Parse(PorcelainBushing.Attributes["H"].Value);
					var N = float.Parse(PorcelainBushing.Attributes["N"].Value);
					float J = Mathf.Deg2Rad * (360 / smooth);
					var pointsH = new List<Vector3>();
					for (int i = 0; i < smooth; i++)
					{
						Vector3 p = new Vector3();
						p.z = 0;
						p.x = R * Mathf.Cos(J * i);
						p.y = R * Mathf.Sin(J * i);
						pointsH.Add(p);
					}

					ProBuilderMesh proBuilderMeshH = ProBuilderMesh.Create();
					proBuilderMeshH.CreateShapeFromPolygon(pointsH, H, false);
					proBuilderMeshH.ToMesh();
					proBuilderMeshH.Refresh();
					proBuilderMeshH.gameObject.transform.SetParent(parent.transform, false);
					float weizhi = 0;
					float nmax = H / (N * 4);
					proBuilderMeshes2.Clear();
					for (int i = 0; i < N; i++)
					{
						if (i != 0)
						{
							weizhi = weizhi + nmax * 2;
						}
						ProBuilderMesh proBuilderMesh = createPorcelainBushing(R, R2, nmax, parent);
						proBuilderMesh.name = "min1";
						Matrix4x4 matrix4x40 = Matrix4x4.Translate(new Vector3(0, 0, weizhi));
						UnityEngine.ProBuilder.Vertex[] vertices0 = proBuilderMesh.GetVertices();
						for (int j = 0; j < vertices0.Length; j++)
						{
							vertices0[j].position = matrix4x40.MultiplyPoint3x4(vertices0[j].position);
						}
						proBuilderMesh.SetVertices(vertices0);
						proBuilderMesh.ToMesh();
						proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
						weizhi = weizhi + nmax;


						ProBuilderMesh proBuilderMesh2 = createPorcelainBushing(R, R1, nmax, parent);
						proBuilderMesh2.name = "min2";
						Matrix4x4 matrix4x41 = Matrix4x4.Translate(new Vector3(0, 0, weizhi + nmax));
						UnityEngine.ProBuilder.Vertex[] vertices = proBuilderMesh2.GetVertices();
						for (int j = 0; j < vertices.Length; j++)
						{
							vertices[j].position = matrix4x41.MultiplyPoint3x4(vertices[j].position);
						}
						proBuilderMesh2.SetVertices(vertices);
						proBuilderMesh2.ToMesh();

						proBuilderMesh2.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
						weizhi = weizhi + nmax;

						proBuilderMeshes2.Add(proBuilderMesh);
						proBuilderMeshes2.Add(proBuilderMesh2);
					}

					proBuilderMeshH.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMeshes2.Add(proBuilderMeshH);
					CombineMeshes.Combine(proBuilderMeshes2, proBuilderMeshes2[proBuilderMeshes2.Count - 1]);
					for (int i = 0; i < proBuilderMeshes2.Count - 1; i++)
					{

						Destroy(proBuilderMeshes2[i].gameObject);
					}
					proBuilderMeshH.gameObject.transform.localPosition = m.GetT();
					proBuilderMeshH.gameObject.transform.localRotation = m.GetR();
					proBuilderMeshH.gameObject.transform.localScale = m.GetS();
					proBuilderMeshH.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMeshH);
					proBuilderMeshDic.Add(id, proBuilderMeshH);
				}
				else if (Sphere != null)
				{
					var R = float.Parse(Sphere.Attributes["R"].Value);

					ProBuilderMesh proBuilderMesh = ShapeGenerator.GenerateTorus(PivotLocation.Center, 16, 24, R, R, true, 360, 360);
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
					proBuilderMesh.gameObject.transform.localScale = m.GetS();
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (Wire != null)
				{
					var StartCoord = Wire.Attributes["StartCoord"].Value;
					var REndCoord = Wire.Attributes["EndCoord"].Value;
					var StartVector = Wire.Attributes["StartVector"].Value;
					var EndVector = Wire.Attributes["EndVector"].Value;
					var Sag = Wire.Attributes["Sag"].Value;
					var D = Wire.Attributes["D"].Value;
					var FitCoordArray = Wire.Attributes["FitCoordArray"].Value;
					string[] StartVectors = StartVector.Split(",");
					string[] EndVectors = EndVector.Split(",");
					string[] StartCoords = StartCoord.Split(",");
					string[] REndCoords = REndCoord.Split(",");

					Vector3 vector3 = new Vector3(float.Parse(StartCoords[0]), float.Parse(StartCoords[1]), float.Parse(StartCoords[2]));

					Vector3 vector31 = new Vector3(float.Parse(REndCoords[0]), float.Parse(REndCoords[1]), float.Parse(REndCoords[2]));

					var length = (vector3 - vector31).magnitude;
					var dir = (vector31 - vector3).normalized;
					var center = vector3 + dir * length / 2;
					Quaternion q = Quaternion.LookRotation(dir);
					m = m * Matrix4x4.Translate(center);
					m = m * Matrix4x4.Rotate(q);
					ProBuilderMesh proBuilderMesh = ShapeGenerator.GenerateCylinder(PivotLocation.Center, 3, float.Parse(D) / 2, length, 1);
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
					var vertices = proBuilderMesh.GetVertices();
					foreach (var vertex in vertices)
					{
						vertex.position = Quaternion.Euler(90, 0, 0) * vertex.position;
						vertex.normal = Quaternion.Euler(90, 0, 0) * vertex.normal;
					}
					proBuilderMesh.SetVertices(vertices);
					proBuilderMesh.ToMesh();
					proBuilderMesh.Refresh();
					//proBuilderMesh.name = modelName;
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);

					proBuilderMesh.transform.localPosition = m.GetT();
					proBuilderMesh.transform.localRotation = m.GetR();
					proBuilderMesh.transform.localScale = m.GetS();
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				else if (Insulator != null)
				{
					var N = int.Parse(Insulator.Attributes["N"].Value);
					var D = float.Parse(Insulator.Attributes["D"].Value);
					var N1 = int.Parse(Insulator.Attributes["N1"].Value);//绝缘子数量
					var H1 = float.Parse(Insulator.Attributes["H1"].Value);
					var R1 = float.Parse(Insulator.Attributes["R1"].Value);
					var R2 = float.Parse(Insulator.Attributes["R2"].Value);
					var R = float.Parse(Insulator.Attributes["R"].Value);
					var FL = float.Parse(Insulator.Attributes["FL"].Value);
					var AL = float.Parse(Insulator.Attributes["AL"].Value);
					var LN = int.Parse(Insulator.Attributes["LN"].Value);
					m = m * Matrix4x4.Rotate(Quaternion.Euler(0, -90, 0));
					//单串绝缘子
					if (N == 1)
					{
						float J = Mathf.Deg2Rad * (360 / smooth);
						var pointsH = new List<Vector3>();
						for (int i = 0; i < smooth; i++)
						{
							Vector3 p = new Vector3();
							p.z = 0;
							p.x = R * Mathf.Sin(J * i);
							p.y = R * Mathf.Cos(J * i);
							pointsH.Add(p);
						}
						ProBuilderMesh proBuilderMeshH = ProBuilderMesh.Create();
						proBuilderMeshH.gameObject.transform.SetParent(parent.transform, false);
						proBuilderMeshH.CreateShapeFromPolygon(pointsH, FL + N1 * H1 + AL, false);

						proBuilderMeshH.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
						proBuilderMeshH.ToMesh();
						proBuilderMeshH.Refresh();

						proBuilderMeshH.transform.localRotation = Quaternion.Euler(0, 180, 0);
						//m = m4 * m;
						float weizhi = FL;
						float nmax = (N1 * H1) / (N1);
						proBuilderMeshes2.Clear();
						proBuilderMeshes2.Add(proBuilderMeshH);
						for (int i = 0; i < N1; i++)
						{
							if (i != 0)
							{
								weizhi = weizhi + nmax / 2;
							}
							ProBuilderMesh proBuilderMesh = createPorcelainBushing(R, i % 2 == 0 ? R2 : R1, nmax / 2, parent);
							proBuilderMesh.name = "min1";
							Matrix4x4 matrix4x40 = Matrix4x4.Translate(new Vector3(0, 0, weizhi));
							Vertex[] vertices0 = proBuilderMesh.GetVertices();
							for (int j = 0; j < vertices0.Length; j++)
							{
								vertices0[j].position = matrix4x40.MultiplyPoint3x4(vertices0[j].position);
							}
							proBuilderMesh.SetVertices(vertices0);
							proBuilderMesh.ToMesh();
							proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
							weizhi = weizhi + nmax / 2;
							proBuilderMesh.name = id + '-' + Path.GetFileName(path);
							proBuilderMeshes2.Add(proBuilderMesh);
						}
						CombineMeshes.Combine(proBuilderMeshes2, proBuilderMeshH);
						for (int i = 1; i < proBuilderMeshes2.Count; i++)
						{
							Destroy(proBuilderMeshes2[i].gameObject);
						}

						proBuilderMeshH.gameObject.transform.localPosition = m.GetT();
						proBuilderMeshH.gameObject.transform.localRotation = m.GetR();
						proBuilderMeshH.gameObject.transform.localScale = m.GetS();
						proBuilderMeshH.name = id + '-' + Path.GetFileName(path);
						proBuilderMeshes.Add(proBuilderMeshH);
						proBuilderMeshDic.Add(id, proBuilderMeshH);
					}
				}
				else if (CircularGasket != null)
				{
					var OR = float.Parse(CircularGasket.Attributes["OR"].Value);
					var IR = float.Parse(CircularGasket.Attributes["IR"].Value);
					var H = float.Parse(CircularGasket.Attributes["H"].Value);
					ProBuilderMesh proBuilderMesh = ShapeGenerator.GeneratePipe(PivotLocation.Center, OR, H, OR - IR, smooth, smooth);
					proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);

					proBuilderMesh.gameObject.transform.localPosition = new Vector3(m.GetT().x, m.GetT().y, m.GetT().z + (H / 2));
					proBuilderMesh.gameObject.transform.localRotation = Quaternion.Euler(-90, 0, 0);
					proBuilderMesh.gameObject.transform.localScale = m.GetS();
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);
					proBuilderMeshes.Add(proBuilderMesh);
					proBuilderMeshDic.Add(id, proBuilderMesh);
				}
				//偏移矩形台
				else if (OffsetRectangularTable != null)
				{
					var TL = OffsetRectangularTable.Attributes["TL"].Value;
					var TW = OffsetRectangularTable.Attributes["TW"].Value;
					var LL = OffsetRectangularTable.Attributes["LL"].Value;
					var LW = OffsetRectangularTable.Attributes["LW"].Value;
					var H = OffsetRectangularTable.Attributes["H"].Value;
					var XOFF = OffsetRectangularTable.Attributes["XOFF"].Value;
					var YOFF = OffsetRectangularTable.Attributes["YOFF"].Value;

				}
				else if (Boolean != null)
				{
					string Entity1 = Boolean.Attributes["Entity1"].Value;
					string Entity2 = Boolean.Attributes["Entity2"].Value;
					if (!enableBooleanCsg)
					{
						if (proBuilderMeshDic.ContainsKey(Entity1))
						{
							proBuilderMeshDic[id] = proBuilderMeshDic[Entity1];
						}
					}
					else if (proBuilderMeshDic.ContainsKey(Entity1) && proBuilderMeshDic.ContainsKey(Entity2))
					{
						string Type = Boolean.Attributes["Type"].Value;
						var e1 = proBuilderMeshDic[Entity1];
						var e2 = proBuilderMeshDic[Entity2];
						var umesh = e1.GetComponent<MeshFilter>().sharedMesh;
						MeshUtility.CollapseSharedVertices(umesh);
						Mesh result = null;
						if (Type.Equals("Difference"))
						{
							result = CSG.Subtract(e1.gameObject, e2.gameObject, true, true);
						}
						else if (Type.Equals("Union"))
						{
							result = CSG.Union(e1.gameObject, e2.gameObject, true, true);
						}
						if (result != null)
						{
							MeshUtility.CollapseSharedVertices(result);
							var p = ProBuilderMesh.Create();
							p.gameObject.transform.SetParent(parent.transform, false);
							p.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
							var meshImporter = new MeshImporter(result, new Material[] { GetMaterialByColor(color) }, p);
							meshImporter.Import();
							p.ToMesh();
							p.Refresh();
							umesh = p.GetComponent<MeshFilter>().sharedMesh;
							MeshUtility.CollapseSharedVertices(umesh);
							p.name = id + '-' + Path.GetFileName(path);
							proBuilderMeshes.Add(p);
							proBuilderMeshDic.Add(id, p);

							proBuilderMeshes.Remove(e1);
							proBuilderMeshes.Remove(e2);
							Destroy(e1.gameObject);
							Destroy(e2.gameObject);
						}
					}
				}
				else if (RotationalEllipsoid != null)
				{
					var LR = float.Parse(RotationalEllipsoid.Attributes["LR"].Value);
					var WR = float.Parse(RotationalEllipsoid.Attributes["WR"].Value);
					var H = float.Parse(RotationalEllipsoid.Attributes["H"].Value);
					var latSegments = 32;
					var lonSegments = 16;

					/*GameObject gameObject1 = new GameObject();
					MeshFilter meshFilter = gameObject1.AddComponent<MeshFilter>();
					MeshRenderer meshRenderer = gameObject1.AddComponent<MeshRenderer>();*/
					Mesh mesh = new Mesh();
					// 创建一个新的网格
					//meshFilter.mesh = mesh;

					// 生成顶点和三角形
					int numVertices = (latSegments + 1) * (lonSegments + 1);
					int numTriangles = latSegments * lonSegments * 6;

					Vector3[] vertices = new Vector3[numVertices];
					int[] triangles = new int[numTriangles];

					int index = 0;

					// 生成顶点
					for (int lat = 0; lat <= latSegments; lat++)
					{
						float theta = lat * Mathf.PI / latSegments;
						float sinTheta = Mathf.Sin(theta);
						float cosTheta = Mathf.Cos(theta);

						for (int lon = 0; lon <= lonSegments; lon++)
						{
							float phi = lon * 2 * Mathf.PI / lonSegments;
							float sinPhi = Mathf.Sin(phi);
							float cosPhi = Mathf.Cos(phi);

							float x = LR * sinTheta * cosPhi;
							float y = WR * sinTheta * sinPhi;
							float z = H * cosTheta;

							vertices[index++] = new Vector3(x, y, z);
						}
					}

					// 生成三角形
					index = 0;
					for (int lat = 0; lat < latSegments; lat++)
					{
						for (int lon = 0; lon < lonSegments; lon++)
						{
							int currentVert = lat * (lonSegments + 1) + lon;
							int nextVert = currentVert + (lonSegments + 1);

							triangles[index++] = currentVert;
							triangles[index++] = nextVert + 1;
							triangles[index++] = currentVert + 1;

							triangles[index++] = currentVert;
							triangles[index++] = nextVert;
							triangles[index++] = nextVert + 1;
						}
					}

					// 将顶点和三角形应用到网格
					mesh.vertices = vertices;
					mesh.triangles = triangles;

					// 计算法线和切线（如果需要）
					mesh.RecalculateNormals();
					mesh.RecalculateTangents();

					// 可选：设置材质，调整渲染设置等
					//meshFilter.mesh = mesh;

					/*                meshFilter.mesh = mesh;
									gameObject1.name = "RotationalEllipsoid";
									gameObject1.GetComponent<MeshFilter>().mesh = meshFilter.mesh;
									gameObject1.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
									gameObject1.gameObject.transform.localScale = new Vector3(0.0025f, 0.001f, 0.002f);
									gameObject1.gameObject.transform.localPosition = m.GetT();
									gameObject1.gameObject.transform.localRotation = m.GetR();
					*/
					ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
					proBuilderMesh.GetComponent<MeshFilter>().mesh = mesh;
					proBuilderMesh.gameObject.GetComponent<MeshRenderer>().material = GetMaterialByColor(color);
					proBuilderMesh.gameObject.transform.localScale = new Vector3(0.0025f, 0.001f, 0.002f);
					proBuilderMesh.gameObject.transform.localPosition = m.GetT();
					proBuilderMesh.gameObject.transform.localRotation = m.GetR();
				
					proBuilderMesh.name = id + '-' + Path.GetFileName(path);

					/*
									proBuilderMeshes.Add(proBuilderMesh);
									proBuilderMeshDic.Add(id, proBuilderMesh);*/

				}
				else if (RoundSteelTube != null)
				{

				}
				else if (EquilateralAngleSteel != null)
				{

				}
				else if (FlatSteel != null)
				{

				}
				else
				{

				}
			}
			if (proBuilderMeshes.Count == 0)
			{
				yield break;
			}
			if (proBuilderMeshes.Count > 1)
			{
				/*var combined = CombineMeshes.Combine(proBuilderMeshes, proBuilderMeshes[0]);
				for (int i = 1; i < proBuilderMeshes.Count; i++)
				{
					Destroy(proBuilderMeshes[i].gameObject);
				}
				foreach (var item in combined)
				{
					item.name = Path.GetFileName(path);
				}*/
			}
			else
			{
				proBuilderMeshes[0].name = Path.GetFileName(path);
			}
		}

		ProBuilderMesh createPorcelainBushing(float R, float R2, float H, GameObject parent)
		{
			proBuilderMeshes3.Clear();
			float J = Mathf.Deg2Rad * (360 / smooth);
			var points1 = new List<Vector3>();
			for (int i = 0; i < smooth; i++)
			{
				Vector3 p = new Vector3();
				p.z = 0;
				p.x = R * Mathf.Sin(J * i);
				p.y = R * Mathf.Cos(J * i);
				points1.Add(p);
			}

			ProBuilderMesh proBuilderMesh = ProBuilderMesh.Create();
			proBuilderMesh.gameObject.transform.SetParent(parent.transform, false);
			proBuilderMesh.CreateShapeFromPolygon(points1, 0f, false);
			ProBuilderMesh proBuilderMesh23 = ProBuilderMesh.Create();
			proBuilderMesh23.gameObject.transform.SetParent(parent.transform, false);
			proBuilderMesh23.CreateShapeFromPolygon(points1, 0f, false);
			Vertex[] vertices = proBuilderMesh.GetVertices();
			Matrix4x4 matrix4x4 = Matrix4x4.Scale(new Vector3(R2 / R, R2 / R, 1));
			Matrix4x4 matrix4x41 = Matrix4x4.Translate(new Vector3(0, 0, H));

			for (int i = 0; i < smooth; i++)
			{
				vertices[i].position = (matrix4x41.MultiplyPoint3x4(vertices[i].position));
			}
			proBuilderMesh.SetVertices(vertices);
			proBuilderMesh.ToMesh();
			proBuilderMesh.Refresh();

			Vertex[] verticesmin = proBuilderMesh23.GetVertices();
			for (int i = 0; i < verticesmin.Length; i++)
			{
				verticesmin[i].position = (matrix4x4.MultiplyPoint3x4(verticesmin[i].position));
			}
			proBuilderMesh23.SetVertices(verticesmin);
			proBuilderMesh23.ToMesh();
			proBuilderMesh23.Refresh();

			proBuilderMeshes3.Add(proBuilderMesh);
			proBuilderMeshes3.Add(proBuilderMesh23);
			CombineMeshes.Combine(proBuilderMeshes3, proBuilderMesh);
			for (int i = 0; i < smooth; i++)
			{
				Face face = proBuilderMesh.Bridge(proBuilderMesh.faces[1].edges[i], proBuilderMesh.faces[0].edges[i]);
				//face.Reverse();
			}
			proBuilderMesh.faces[1].Reverse();
			proBuilderMesh.ToMesh();
			proBuilderMesh.Refresh();
			Destroy(proBuilderMesh23.gameObject);
			return proBuilderMesh;

		}

		private IEnumerator ParseIfc(string path, GameObject parent)
		{
            if (!File.Exists(path)) {
                yield break;
            }
			var name = Path.GetFileNameWithoutExtension(path);
			var xbimFile = Path.Combine(Path.GetDirectoryName(path), name + ".Xbim");
			if (!File.Exists(xbimFile))
			{
				yield return Task.Run(() =>
				{
					Process process = new Process();
					ProcessStartInfo startInfo = new ProcessStartInfo(_Ifc2XbimUrl, path);
					process.StartInfo = startInfo;
					process.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
					process.Start();
					process.WaitForExit();
					process.Close();
				});
			}
            
            if (!File.Exists(xbimFile))
            {
                Debug.Log(string.Format("ifc转xbim失败.({0})", path));
                yield break;
            }
			var obj = new Parser().Parse(xbimFile);
			obj.transform.SetParent(parent.transform, false);
			obj.transform.localScale = Vector3.one;
		}

		private Task DeCompressGim()
        {
            return Task.Run(() =>
            {
                using (var fileStream = new FileStream(gimFilePath, FileMode.Open, FileAccess.Read))
                {
                    gimFileInfo = new GimFileInfo();
                    byte[] buff = new byte[256];
                    var len = fileStream.Read(buff, 0, 16);
                    gimFileInfo.fileFlag = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 256);
                    gimFileInfo.fileName = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 64);
                    gimFileInfo.designer = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 256);
                    gimFileInfo.organization = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 128);
                    gimFileInfo.softName = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 16);
                    gimFileInfo.createTime = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 8);
                    gimFileInfo.softMajorVersion = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 8);
                    gimFileInfo.softMinorVersion = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 8);
                    gimFileInfo.specificationMajorVersion = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 8);
                    gimFileInfo.specificationMinorVersion = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    len = fileStream.Read(buff, 0, 8);
                    gimFileInfo.dataSize = Encoding.UTF8.GetString(buff, 0, len).Replace("\0", "").Trim();
                    Debug.Log(gimFileInfo);

                    var extractor = new SevenZipExtractor(fileStream, true, InArchiveFormat.SevenZip);
					extractor.Extracting += Extractor_Extracting;
					extractor.ExtractionFinished += Extractor_ExtractionFinished;
					extractor.FileExtractionStarted += Extractor_FileExtractionStarted;
					extractor.FileExtractionFinished += Extractor_FileExtractionFinished;

					dir = Path.Combine(Path.GetDirectoryName(gimFilePath), Path.GetFileNameWithoutExtension(gimFilePath));
					dirCBM = Path.Combine(dir, "Cbm");
					dirDEV = Path.Combine(dir, "Dev");
					dirPHM = Path.Combine(dir, "Phm");
					dirMOD = Path.Combine(dir, "Mod");
					if (Directory.Exists(dir))
					{
						return;
						//Directory.Delete(dir, true);
					}
					Directory.CreateDirectory(dir);
					extractor.ExtractArchive(dir);
					extractionFinishedInvoked = 1;
				}
            });
        }

        private void Extractor_FileExtractionFinished(object sender, FileInfoEventArgs e)
        {
            Debug.LogFormat("FileExtractionFinished. {0}", e.FileInfo.FileName);
        }

        private void Extractor_FileExtractionStarted(object sender, FileInfoEventArgs e)
        {
            Debug.LogFormat("FileExtractionStarted. {0}", e.FileInfo.FileName);
        }

        private void Extractor_ExtractionFinished(object sender, EventArgs e)
        {
            Debug.LogFormat("ExtractionFinished. {0}", e);
            extractionFinishedInvoked++;
		}

        private void Extractor_Extracting(object sender, ProgressEventArgs e)
        {
            Debug.LogFormat("Extracting. {0}", e.PercentDelta);
        }

		private Material GetMaterialByColor(Color color)
		{
			Material mat;
			if (matDic.ContainsKey(color))
			{
				mat = matDic[color];
			}
			else
			{
				mat = new Material(Shader.Find("Standard"));
				mat.name = color.ToString();
				mat.SetColor("_Color", color);
				matDic.Add(color, mat);
			}
			return mat;
		}
	}
}
