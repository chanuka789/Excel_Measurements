"""Writes manifest.xml: the DWFx Measure ribbon tab (shared runtime). Run: python3 scripts/make-manifest.py [base-url]"""
import sys, os
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://dwfx-addin-production.up.railway.app').rstrip('/')
VERSION = '0.4.0.0'
G = [
 ('Project', 'Project', 'group', [('Projects', 'Projects', 'projects', 'openProjects', 'Open your projects: models, drawings, team, saved take-offs and settings.'),
                                  ('Refresh', 'Refresh', 'refresh', 'refreshProject', 'Reload the open project to see new uploads and processing status.')]),
 ('Model', 'Model', 'group', [('Elements', 'Elements', 'elements', 'openElements', 'Browse the model elements by category, family and type.'),
                              ('Zones', 'Zones', 'zones', 'openZones', 'Named zones (Villa, Annex, Block A) to split take-offs and colour the model.'),
                              ('Window', '3D window', 'window', 'view3DWindow', 'Open the model in a large window that can go on a second screen, with drawings side by side.')]),
 ('View', '3D view', 'group', [('Fit', 'Fit view', 'fit', 'viewFit', 'Zoom the 3D view to the visible elements.'),
                               ('Views', 'Views', 'views', 'viewViews', 'Top, front, side and isometric views; perspective or orthographic.'),
                               ('Section', 'Section box', 'section', 'viewSection', 'Cut the model with a section box to see inside.'),
                               ('Plan', 'Level plan', 'plan', 'viewPlan', 'Top view of one level, cut at a set height, like a plan drawing.'),
                               ('Saved', 'Saved views', 'saved', 'viewSaved', 'Save or open views with camera, section, selection and colours, shared with the team.')]),
 ('Select', 'Select', 'group', [('Isolate', 'Isolate', 'isolate', 'viewIsolate', 'Show only the selected elements. Press again to show the rest.'),
                                ('Hide', 'Hide', 'hide', 'viewHide', 'Hide the selected elements.'),
                                ('ShowAll', 'Show all', 'showall', 'viewShowAll', 'Show every element and clear isolate, hide and the level filter.'),
                                ('Box', 'Box select', 'box', 'viewBoxSelect', 'Drag a box: left to right selects elements fully inside, right to left anything touched.'),
                                ('Clear', 'Clear selection', 'clear', 'viewClear', 'Clear the element selection.'),
                                ('FromExcel', 'Select from Excel', 'fromexcel', 'selectFromExcel', 'Highlight in 3D the elements of the Take-off rows selected in Excel.')]),
 ('Measure', 'Measure', 'group', [('Measure', 'Measure', 'measure', 'openMeasure', 'Measure the selected elements and add live formulas to the Take-off sheet.'),
                                  ('Templates', 'Templates', 'templates', 'openTemplates', 'Saved methods and discipline packs for Structure, Architecture, Interiors and MEP.'),
                                  ('Tool', 'Distance and area', 'measure', 'viewMeasure', 'Measure a distance between two points or the area of a face in 3D.'),
                                  ('Colour', 'Colour by', 'colour', 'viewColour', 'Colour the model by category, level, material, zone, property or revision changes.'),
                                  ('Status', 'Measured status', 'status', 'measuredStatus', 'Green measured, purple measured twice, red not measured yet.')]),
 ('AI', 'AI', 'group', [('AskAI', 'Ask AI', 'ai', 'openAI', 'Ask the AI to work out a measurement method; it tests it on the model before you add it.'),
                        ('Check', 'Check take-off', 'aicheck', 'aiCheck', 'AI review of the take-off for missing items, odd values, unit mistakes and double counting.')]),
 ('Revisions', 'Revisions', 'group', [('Compare', 'Compare revisions', 'compare', 'compareRevisions', 'Added, removed and changed elements between two model versions, with quantity differences.'),
                                      ('Update', 'Update take-off', 'update', 'updateTakeoff', 'Re-measure take-off groups on the new revision, keeping formulas and assumptions.')]),
 ('Output', 'Output', 'group', [('BOQ', 'Build BOQ', 'boq', 'buildBOQ', 'Build a BOQ sheet linked to the take-off totals, with AI descriptions if you want.'),
                                ('PDF', 'Audit PDF', 'pdf', 'auditPdf', 'A PDF with the method, assumptions, counts, totals and a 3D picture of every group.'),
                                ('Review', 'Model checks', 'review', 'modelChecks', 'Missing data, overlapping concrete and measured status.'),
                                ('Admin', 'Admin', 'admin', 'openAdmin', 'Users, AI settings, QS rules, backups and system status (administrators only).')]),
]
icons = sorted({g[2] for g in G} | {c[2] for g in G for c in g[3]})
ic = lambda n: '\n'.join(f'                    <bt:Image size="{s}" resid="I.{n}.{s}"/>' for s in (16, 32, 80))
groups = []
for gid, glabel, gicon, ctrls in G:
    cs = [f'''                <Control xsi:type="Button" id="DWFx.{cid}">
                  <Label resid="L.{cid}"/>
                  <Supertip><Title resid="L.{cid}"/><Description resid="T.{cid}"/></Supertip>
                  <Icon>
{ic(icon)}
                  </Icon>
                  <Action xsi:type="ExecuteFunction"><FunctionName>{fn}</FunctionName></Action>
                </Control>''' for cid, label, icon, fn, tip in ctrls]
    groups.append(f'''              <Group id="DWFx.G.{gid}">
                <Label resid="G.{gid}"/>
                <Icon>
{ic(gicon)}
                </Icon>
{chr(10).join(cs)}
              </Group>''')
images = '\n'.join(f'        <bt:Image id="I.{n}.{s}" DefaultValue="{BASE}/assets/ribbon/{n}-{s}.png"/>' for n in icons for s in (16, 32, 80))
short = '\n'.join([f'        <bt:String id="G.{g[0]}" DefaultValue="{g[1]}"/>' for g in G] + [f'        <bt:String id="L.{c[0]}" DefaultValue="{c[1]}"/>' for g in G for c in g[3]]
                  + ['        <bt:String id="TabLabel" DefaultValue="DWFx Measure"/>', '        <bt:String id="GetStarted.Title" DefaultValue="DWFx Measure is ready"/>'])
long = '\n'.join([f'        <bt:String id="T.{c[0]}" DefaultValue="{c[4]}"/>' for g in G for c in g[3]]
                 + ['        <bt:String id="GetStarted.Description" DefaultValue="Open the DWFx Measure tab on the ribbon and choose Projects to sign in."/>'])
xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- DWFx Measure add-in (generated by scripts/make-manifest.py). Live address: {BASE}
     Ribbon tab "DWFx Measure" with a shared runtime: the task pane and the ribbon buttons run in the same page. -->
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>6f1c2a4e-8d3b-4f7a-9c51-2b7e0d4a9f13</Id>
  <Version>{VERSION}</Version>
  <ProviderName>QSGS</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="DWFx Measure"/>
  <Description DefaultValue="View any Revit DWFx model in 3D, measure with live Excel formulas, compare revisions, build the BOQ and keep every project on your server."/>
  <IconUrl DefaultValue="{BASE}/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="{BASE}/assets/icon-64.png"/>
  <SupportUrl DefaultValue="{BASE}/"/>
  <AppDomains>
    <AppDomain>{BASE}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Workbook"/>
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.9">
      <Set Name="ExcelApi" MinVersion="1.9"/>
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue="{BASE}/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.1">
        <bt:Set Name="SharedRuntime" MinVersion="1.1"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="Workbook">
        <Runtimes>
          <Runtime resid="PaneUrl" lifetime="long"/>
        </Runtimes>
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="GetStarted.Title"/>
            <Description resid="GetStarted.Description"/>
            <LearnMoreUrl resid="PaneUrl"/>
          </GetStarted>
          <FunctionFile resid="PaneUrl"/>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <CustomTab id="DWFx.Tab">
{chr(10).join(groups)}
              <Label resid="TabLabel"/>
            </CustomTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
{images}
      </bt:Images>
      <bt:Urls>
        <bt:Url id="PaneUrl" DefaultValue="{BASE}/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
{short}
      </bt:ShortStrings>
      <bt:LongStrings>
{long}
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
'''
out = os.path.join(os.path.dirname(__file__), '..', 'manifest.xml')
open(out, 'w').write(xml)
fns = sorted({c[3] for g in G for c in g[3]})
print('manifest', VERSION, 'buttons', sum(len(g[3]) for g in G), 'functions', len(fns)); print(' '.join(fns))
