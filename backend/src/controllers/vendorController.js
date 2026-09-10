import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import WifiSecurityMapping from '../models/WifiSecurityMapping.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class VendorController {
  static async getAllVendors(req, res) {
    try {
      const vendors = await Vendor.getAll();
      return res.json(
        createResponse(req.t('vendor.listRetrieved'), vendors)
      );
    } catch (error) {
      console.error('Get all vendors error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.listFailed'), error.message)
      );
    }
  }

  static async getVendorById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const vendor = await Vendor.findById(id);
      
      if (!vendor) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.retrieved'), vendor)
      );
    } catch (error) {
      console.error('Get vendor by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.getFailed'), error.message)
      );
    }
  }

  static async createVendor(req, res) {
    try {
      const vendorData = req.body;
      
      if (!vendorData.name || !vendorData.manufacturer_patterns || !vendorData.product_patterns) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.fieldsRequired'))
        );
      }

      const vendorId = await Vendor.create(vendorData);
      // `null` is the model refusing a name this provider already uses. Told
      // apart from a failure on purpose: nothing went wrong, the operator is
      // being asked to pick a name they can find the row by later.
      if (vendorId === null) {
        return res.status(409).json(createErrorResponse(req.t('vendor.nameTaken')));
      }

      return res.status(201).json(
        createResponse(req.t('vendor.created'), { id: vendorId })
      );
    } catch (error) {
      console.error('Create vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.createFailed'), error.message)
      );
    }
  }

  static async updateVendor(req, res) {
    try {
      const { id } = req.params;
      const vendorData = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const updated = await Vendor.update(id, vendorData);

      if (updated === null) {
        return res.status(409).json(createErrorResponse(req.t('vendor.nameTaken')));
      }
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.updated'))
      );
    } catch (error) {
      console.error('Update vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.updateFailed'), error.message)
      );
    }
  }

  static async deleteVendor(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const deleted = await Vendor.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.deleted'))
      );
    } catch (error) {
      console.error('Delete vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.deleteFailed'), error.message)
      );
    }
  }

  static async getWifiSecurityMappings(req, res) {
    try {
      const { vendorId } = req.params;
      
      if (!vendorId) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      // O fabricante é conferido antes da lista, e não só filtrado por ela.
      // Sem isto, o id de um fabricante do provedor vizinho respondia 200 com
      // lista vazia — indistinguível de "este fabricante não tem mapeamento
      // nenhum", que é uma resposta sobre um registro que não é de quem
      // pergunta. 404 é o que a irmã desta rota (o POST no mesmo caminho) e o
      // `GET /api/vendor-management/:id` já respondiam.
      if (!(await Vendor.findById(vendorId))) {
        return res.status(404).json(createErrorResponse(req.t('vendor.notFound')));
      }

      const mappings = await WifiSecurityMapping.getByVendor(vendorId);

      return res.json(
        createResponse(req.t('wifiMapping.listRetrieved'), mappings)
      );
    } catch (error) {
      console.error('Get WiFi security mappings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiMapping.listFailed'), error.message)
      );
    }
  }

  static async createWifiSecurityMapping(req, res) {
    try {
      const vendor_id = Number(req.params.vendorId);
      const { raw_security_value, normalized_security, description } = req.body;
      
      if (!Number.isInteger(vendor_id) || vendor_id < 1 || !raw_security_value || !normalized_security) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiMapping.fieldsRequired'))
        );
      }

      if (!(await Vendor.findById(vendor_id))) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      await WifiSecurityMapping.create({ vendor_id, raw_security_value, normalized_security, description });

      return res.status(201).json(
        createResponse(req.t('wifiMapping.created'))
      );
    } catch (error) {
      console.error('Create WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiMapping.createFailed'), error.message)
      );
    }
  }

  static async updateWifiSecurityMapping(req, res) {
    try {
      const { id } = req.params;
      const { raw_security_value, normalized_security, description } = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiMapping.idRequired'))
        );
      }

      const updated = await WifiSecurityMapping.update(id, { raw_security_value, normalized_security, description });

      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiMapping.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiMapping.updated'))
      );
    } catch (error) {
      console.error('Update WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiMapping.updateFailed'), error.message)
      );
    }
  }

  static async deleteWifiSecurityMapping(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiMapping.idRequired'))
        );
      }

      const deleted = await WifiSecurityMapping.delete(id);

      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiMapping.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiMapping.deleted'))
      );
    } catch (error) {
      console.error('Delete WiFi security mapping error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiMapping.deleteFailed'), error.message)
      );
    }
  }

  static async getAllWifiSecurityConfigs(req, res) {
    try {
      const configs = await WifiSecurityConfig.getAll();
      return res.json(
        createResponse(req.t('wifiConfig.listRetrieved'), configs)
      );
    } catch (error) {
      console.error('Get all WiFi security configs error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.listFailed'), error.message)
      );
    }
  }

  static async getWifiSecurityConfigById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      const config = await WifiSecurityConfig.getById(id);
      
      if (!config) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.retrieved'), config)
      );
    } catch (error) {
      console.error('Get WiFi security config by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.getFailed'), error.message)
      );
    }
  }

  static async getWifiSecurityConfigByProductClass(req, res) {
    try {
      const { productClass } = req.params;

      if (!productClass) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.productClassRequired'))
        );
      }

      const config = await WifiSecurityConfig.getByProductClass(productClass);

      if (!config) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFoundForProductClass'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.retrieved'), config)
      );
    } catch (error) {
      console.error('Get WiFi security config by product class error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.getFailed'), error.message)
      );
    }
  }

  static async createWifiSecurityConfig(req, res) {
    try {
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.fieldsRequired'))
        );
      }

      const configId = await WifiSecurityConfig.create({
        product_class,
        security_types,
        password_param_path
      });
      // `null` is the model refusing a product class this provider already has
      // a config for. Worth a real answer rather than a second row: the WiFi
      // write path reads the FIRST match, so the row added here would never
      // apply, and nothing on screen would say why the old one kept winning.
      if (configId === null) {
        return res.status(409).json(createErrorResponse(req.t('wifiConfig.productClassTaken')));
      }

      return res.status(201).json(
        createResponse(req.t('wifiConfig.created'), { id: configId })
      );
    } catch (error) {
      console.error('Create WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.createFailed'), error.message)
      );
    }
  }

  static async updateWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.fieldsRequired'))
        );
      }

      const updated = await WifiSecurityConfig.update(id, {
        product_class,
        security_types,
        password_param_path
      });

      if (updated === null) {
        return res.status(409).json(createErrorResponse(req.t('wifiConfig.productClassTaken')));
      }
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.updated'))
      );
    } catch (error) {
      console.error('Update WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.updateFailed'), error.message)
      );
    }
  }

  static async deleteWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      const deleted = await WifiSecurityConfig.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.deleted'))
      );
    } catch (error) {
      console.error('Delete WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.deleteFailed'), error.message)
      );
    }
  }
}

export default VendorController;
