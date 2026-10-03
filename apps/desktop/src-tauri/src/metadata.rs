use dotnetdll::prelude::{ReadOptions, Resolution};
use dotnetdll::resolved::{
    attribute::FixedArg,
    members::{MethodReferenceParent, UserMethod},
    types::{AlwaysFailsResolver, BaseType, MethodType, ResolutionScope, TypeSource, UserType},
};
use serde::Serialize;

pub const MENU_GUID: &str = "org.iidk.gorillatag.iimenu";

pub const MENU_GUIDS: &[&str] = &[MENU_GUID, "corgi.gorillatag.iireborn"];

pub fn is_menu_guid(guid: &str) -> bool {
    MENU_GUIDS.contains(&guid)
}

#[derive(Clone, Serialize)]
pub struct Plugin {
    pub guid: String,
    pub name: String,
    pub version: String,
}

#[derive(Serialize)]
pub struct AssemblyMetadata {
    pub name: String,
    pub version: String,
    pub plugins: Vec<Plugin>,
}

pub fn inspect(bytes: &[u8]) -> Result<AssemblyMetadata, String> {
    if bytes.len() < 512 || bytes.len() > 100_000_000 || !bytes.starts_with(b"MZ") {
        return Err("Not a bounded PE/.NET assembly".into());
    }
    let resolution = Resolution::parse(
        bytes,
        ReadOptions {
            skip_method_bodies: true,
            ..Default::default()
        },
    )
    .map_err(|_| "Invalid managed assembly metadata")?;
    let assembly = resolution
        .assembly
        .as_ref()
        .ok_or("Missing .NET assembly identity")?;
    let mut plugins = Vec::new();
    for ty in &resolution.type_definitions {
        for attribute in &ty.attributes {
            let UserMethod::Reference(index) = attribute.constructor else {
                continue;
            };
            let constructor = &resolution[index];
            if constructor.name != ".ctor" {
                continue;
            }
            let MethodReferenceParent::Type(MethodType::Base(base)) = &constructor.parent else {
                continue;
            };
            let BaseType::Type {
                source: TypeSource::User(UserType::Reference(type_index)),
                ..
            } = base.as_ref()
            else {
                continue;
            };
            let reference = &resolution[*type_index];
            if reference.namespace.as_deref() != Some("BepInEx") || reference.name != "BepInPlugin"
            {
                continue;
            }
            let ResolutionScope::Assembly(assembly_index) = reference.scope else {
                continue;
            };
            if resolution[assembly_index].name != "BepInEx" {
                continue;
            }
            let data = attribute
                .instantiation_data(&AlwaysFailsResolver, &resolution)
                .map_err(|_| "Malformed BepInPlugin attribute")?;
            let [FixedArg::String(Some(guid)), FixedArg::String(Some(name)), FixedArg::String(Some(version))] =
                data.constructor_args.as_slice()
            else {
                return Err("Invalid BepInPlugin constructor arguments".into());
            };
            if guid.len() > 200 || name.len() > 200 || version.len() > 80 {
                return Err("Oversized plugin metadata".into());
            }
            plugins.push(Plugin {
                guid: guid.to_string(),
                name: name.to_string(),
                version: version.to_string(),
            });
        }
    }
    let v = assembly.version;
    Ok(AssemblyMetadata {
        name: assembly.name.to_string(),
        version: format!("{}.{}.{}.{}", v.major, v.minor, v.build, v.revision),
        plugins,
    })
}

pub fn verify_menu(bytes: &[u8], expected_version: &str) -> Result<Plugin, String> {
    let assembly = inspect(bytes)?;
    let matching: Vec<_> = assembly
        .plugins
        .into_iter()
        .filter(|plugin| is_menu_guid(&plugin.guid))
        .collect();
    if matching.len() != 1 {
        return Err("Expected exactly one ii menu plugin GUID".into());
    }
    let plugin = matching.into_iter().next().unwrap();
    let actual = semver::Version::parse(&plugin.version).map_err(|_| "Invalid plugin version")?;
    if actual != semver::Version::parse(expected_version).map_err(|_| "Invalid release version")? {
        return Err("Plugin version does not match trusted release".into());
    }
    Ok(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strings_do_not_prove_managed_metadata() {
        assert!(inspect(b"org.iidk.gorillatag.iimenu BepInPlugin").is_err());
        let mut fake = vec![0u8; 4096];
        fake[0..2].copy_from_slice(b"MZ");
        assert!(inspect(&fake).is_err());
    }
    #[test]
    fn reads_real_fixture_attributes_and_rejects_wrong_version() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../work/managed-fixtures");
        let bytes = std::fs::read(root.join("MenuFixture.dll"))
            .expect("Run scripts/create-managed-fixtures.ps1 before native tests");
        let plugin = verify_menu(&bytes, "1.0.3").unwrap();
        assert_eq!(plugin.guid, MENU_GUID);
        assert!(verify_menu(&bytes, "1.0.4").is_err());
        let loader = std::fs::read(root.join("BepInEx.dll")).unwrap();
        assert_eq!(inspect(&loader).unwrap().version, "5.4.23.5");
        assert!(verify_menu(&loader, "1.0.3").is_err());
    }
    #[test]
    fn accepts_every_shipped_menu_guid_and_rejects_others() {
        assert!(is_menu_guid("org.iidk.gorillatag.iimenu"));
        assert!(is_menu_guid("corgi.gorillatag.iireborn"));
        assert!(!is_menu_guid("corgi.gorillatag.iireborn.extra"));
        assert!(!is_menu_guid("BepInEx"));
        assert!(!is_menu_guid(""));
    }
}
